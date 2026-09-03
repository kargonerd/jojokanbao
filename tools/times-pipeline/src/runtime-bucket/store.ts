import { deleteFiles, downloadFile, listFiles, pathsInfo, uploadFiles } from "@huggingface/hub";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { retryTransientHf } from "../hf.js";
import {
  RUNTIME_MAX_DOWNLOAD_BYTES,
  RUNTIME_MAX_TEXT_BYTES,
  RUNTIME_PREFIX,
  type RuntimeObjectInfo,
  type RuntimeObjectStore,
  type RuntimeReadOptions,
  runtimeReadLimit,
  safeRuntimePath,
} from "./types.js";

function runtimeObjectName(value: unknown): string {
  const objectName = safeRuntimePath(value, "Runtime Bucket object");
  if (!objectName.startsWith(`${RUNTIME_PREFIX}/`)) {
    throw new Error(`Runtime Bucket object is outside ${RUNTIME_PREFIX}/: ${objectName}`);
  }
  return objectName;
}

function runtimeListPrefix(value: unknown): string {
  const prefix = safeRuntimePath(value, "Runtime Bucket list prefix").replace(/\/$/u, "");
  if (prefix !== RUNTIME_PREFIX && !prefix.startsWith(`${RUNTIME_PREFIX}/`)) {
    throw new Error(`Runtime Bucket list prefix is outside ${RUNTIME_PREFIX}/: ${prefix}`);
  }
  return prefix;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

function bucketRetry(label: string): { attempts: number; delayMs: number; label: string } {
  return { attempts: 8, delayMs: 1_000, label };
}

function validateBlobSize(blob: Blob, maxBytes: number, label: string): void {
  if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
    throw new Error(`${label} reported an invalid byte size`);
  }
  if (blob.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte download limit`);
  }
}

async function* limitedBlobBody(blob: Blob, maxBytes: number, label: string): AsyncGenerator<Uint8Array> {
  validateBlobSize(blob, maxBytes, label);
  let bytes = 0;
  for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte download limit while streaming`);
    }
    yield chunk;
  }
  if (bytes !== blob.size) {
    throw new Error(`${label} byte count changed while downloading: expected ${blob.size}, got ${bytes}`);
  }
}

async function limitedBlobText(blob: Blob, maxBytes: number, label: string): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for await (const chunk of limitedBlobBody(blob, maxBytes, label)) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export class HfRuntimeBucket implements RuntimeObjectStore {
  private readonly repo: { type: "bucket"; name: string };

  constructor(bucket: string, private readonly accessToken: string) {
    const name = bucket.trim().replace(/^buckets\//u, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
      throw new Error(`Invalid HF Runtime Bucket: ${bucket}`);
    }
    if (!accessToken.trim()) throw new Error("HF Runtime Bucket token is empty");
    this.repo = { type: "bucket", name };
  }

  async upload(objectNameValue: string, localFileValue: string): Promise<void> {
    const objectName = runtimeObjectName(objectNameValue);
    const localFile = path.resolve(localFileValue);
    const expectedSize = (await stat(localFile)).size;
    await retryTransientHf(() => uploadFiles({
      repo: this.repo,
      accessToken: this.accessToken,
      files: [{ path: objectName, content: pathToFileURL(localFile) }],
      useWebWorkers: false,
      useXet: true,
    }), bucketRetry(`upload Runtime Bucket ${objectName}`));
    const uploaded = await this.info(objectName);
    if (!uploaded || uploaded.size !== expectedSize) {
      throw new Error(`Runtime Bucket upload verification failed for ${objectName}`);
    }
  }

  async download(objectNameValue: string, localFileValue: string, options?: RuntimeReadOptions): Promise<boolean> {
    const objectName = runtimeObjectName(objectNameValue);
    const localFile = path.resolve(localFileValue);
    const maxBytes = runtimeReadLimit(options, RUNTIME_MAX_DOWNLOAD_BYTES, "Runtime download byte limit");
    let blob: Blob | null;
    try {
      blob = await retryTransientHf(() => downloadFile({
        repo: this.repo,
        accessToken: this.accessToken,
        path: objectName,
      }), bucketRetry(`download Runtime Bucket ${objectName}`));
    } catch (error) {
      if (statusCode(error) === 404) return false;
      throw error;
    }
    if (!blob) return false;
    validateBlobSize(blob, maxBytes, `Runtime Bucket object ${objectName}`);
    await mkdir(path.dirname(localFile), { recursive: true });
    const temporary = path.join(path.dirname(localFile), `.${path.basename(localFile)}.${randomUUID()}.tmp`);
    try {
      await pipeline(
        Readable.from(limitedBlobBody(blob, maxBytes, `Runtime Bucket object ${objectName}`)),
        createWriteStream(temporary, { flags: "wx" }),
      );
      await rename(temporary, localFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return true;
  }

  async readText(objectNameValue: string, options?: RuntimeReadOptions): Promise<string | null> {
    const objectName = runtimeObjectName(objectNameValue);
    const maxBytes = runtimeReadLimit(options, RUNTIME_MAX_TEXT_BYTES, "Runtime text byte limit");
    try {
      const blob = await retryTransientHf(() => downloadFile({
        repo: this.repo,
        accessToken: this.accessToken,
        path: objectName,
      }), bucketRetry(`read Runtime Bucket ${objectName}`));
      return blob ? limitedBlobText(blob, maxBytes, `Runtime Bucket text object ${objectName}`) : null;
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
  }

  async info(objectNameValue: string): Promise<RuntimeObjectInfo | null> {
    const objectName = runtimeObjectName(objectNameValue);
    let rows;
    try {
      rows = await retryTransientHf(() => pathsInfo({
        repo: this.repo,
        accessToken: this.accessToken,
        paths: [objectName],
        expand: true,
      }), bucketRetry(`inspect Runtime Bucket ${objectName}`));
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
    const row = rows.find((entry) => entry.path === objectName);
    if (!row || row.type !== "file") return null;
    return {
      objectName,
      size: row.size,
      ...(row.uploadedAt ? { uploadedAt: row.uploadedAt } : {}),
    };
  }

  async list(prefixValue: string): Promise<RuntimeObjectInfo[]> {
    const prefix = runtimeListPrefix(prefixValue);
    try {
      return await retryTransientHf(async () => {
        const objects: RuntimeObjectInfo[] = [];
        for await (const row of listFiles({
          repo: this.repo,
          accessToken: this.accessToken,
          path: prefix,
          recursive: true,
          expand: true,
        })) {
          if (row.type !== "file") continue;
          const objectName = runtimeObjectName(row.path);
          if (objectName !== prefix && !objectName.startsWith(`${prefix}/`)) {
            throw new Error(`HF returned an object outside ${prefix}: ${objectName}`);
          }
          objects.push({
            objectName,
            size: row.size,
            ...(row.uploadedAt ? { uploadedAt: row.uploadedAt } : {}),
          });
        }
        return objects.sort((left, right) => left.objectName.localeCompare(right.objectName));
      }, bucketRetry(`list Runtime Bucket ${prefix}`));
    } catch (error) {
      if (statusCode(error) === 404) return [];
      throw error;
    }
  }

  async delete(objectNameValues: readonly string[]): Promise<void> {
    const objectNames = [...new Set(objectNameValues.map(runtimeObjectName))];
    if (!objectNames.length) return;
    await retryTransientHf(() => deleteFiles({
      repo: this.repo,
      accessToken: this.accessToken,
      paths: objectNames,
    }), bucketRetry(`delete ${objectNames.length} Runtime Bucket object(s)`));
  }
}
