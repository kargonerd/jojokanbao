import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type CredentialFile = Record<string, Credential>;

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  return value.type === "api_key" || value.type === "oauth";
}
/**
 * Persistent store compatible with the auth.json produced by pi-ai's login
 * CLI. Credential values are never logged or returned by status APIs.
 */
export class JsonCredentialStore implements CredentialStore {
  readonly path: string;
  private queues = new Map<string, Promise<void>>();

  constructor(path = fileURLToPath(new URL("../auth.json", import.meta.url))) {
    this.path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credentials = await this.readAll();
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const credentials = await this.readAll();
      const current = credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.writeAll(credentials);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(providerId, async () => {
      const credentials = await this.readAll();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.writeAll(credentials);
    });
  }

  private async readAll(): Promise<CredentialFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Pi auth.json 格式错误");
      }
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, Credential] => isCredential(entry[1])),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(credentials: CredentialFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  private async enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.queues.set(providerId, current.then(() => undefined, () => undefined));
    return current;
  }
}
