import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Converter } from "opencc-js";
import type { DocumentRecord, PublicDocument, SearchHit } from "./types.js";

const toSimplified = Converter({ from: "hk", to: "cn" });
const MAX_TOOL_CHARS = 16_000;
const MAX_SEARCH_EXCERPT_CHARS = 2_400;

interface CachedDocument {
  mtimeMs: number;
  lines: string[];
  normalizedLines: string[];
}

function normalizeForSearch(value: string): string {
  return toSimplified(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function inferTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback.replace(/\.md$/i, "");
}

function toPublicDocument(record: DocumentRecord): PublicDocument {
  const { storedName: _storedName, ...document } = record;
  return document;
}

function informationScore(hit: SearchHit): number {
  return hit.excerpt
    .replace(/^L\d+\s*\|\s*/gm, "")
    .replace(/\s+/g, "")
    .length;
}

function compareHits(left: SearchHit, right: SearchHit): number {
  return right.matchedQueries.length - left.matchedQueries.length
    || informationScore(right) - informationScore(left)
    || left.startLine - right.startLine;
}

export class DocumentStore {
  readonly dataDirectory: string;
  readonly documentsDirectory: string;
  readonly manifestPath: string;
  private cache = new Map<string, CachedDocument>();

  constructor(dataDirectory = fileURLToPath(new URL("../data", import.meta.url))) {
    this.dataDirectory = dataDirectory;
    this.documentsDirectory = join(dataDirectory, "documents");
    this.manifestPath = join(dataDirectory, "documents.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.documentsDirectory, { recursive: true });
    try {
      await stat(this.manifestPath);
    } catch {
      await writeFile(this.manifestPath, "[]\n", "utf8");
    }
  }

  async list(): Promise<PublicDocument[]> {
    const records = await this.readManifest();
    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPublicDocument);
  }

  async add(input: { originalName: string; content: Buffer; title?: string }): Promise<PublicDocument> {
    await this.initialize();
    if (extname(input.originalName).toLocaleLowerCase() !== ".md") {
      throw new Error("只支持 Markdown（.md）文件");
    }

    const markdown = input.content.toString("utf8").replace(/^\uFEFF/, "");
    if (!markdown.trim()) throw new Error("Markdown 文件内容为空");

    const id = randomUUID();
    const storedName = `${id}.md`;
    const record: DocumentRecord = {
      id,
      title: input.title?.trim() || inferTitle(markdown, basename(input.originalName)),
      originalName: basename(input.originalName),
      storedName,
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
      lineCount: markdown.split(/\r?\n/).length,
      createdAt: new Date().toISOString(),
    };

    await writeFile(join(this.documentsDirectory, storedName), markdown, "utf8");
    const records = await this.readManifest();
    records.push(record);
    await this.writeManifest(records);
    return toPublicDocument(record);
  }

  async remove(id: string): Promise<boolean> {
    const records = await this.readManifest();
    const target = records.find((record) => record.id === id);
    if (!target) return false;

    await unlink(join(this.documentsDirectory, target.storedName)).catch(() => undefined);
    await this.writeManifest(records.filter((record) => record.id !== id));
    this.cache.delete(id);
    return true;
  }

  async requireRecords(ids: string[]): Promise<DocumentRecord[]> {
    const uniqueIds = [...new Set(ids)];
    const records = await this.readManifest();
    const byId = new Map(records.map((record) => [record.id, record]));
    const selected = uniqueIds.map((id) => byId.get(id)).filter((record): record is DocumentRecord => Boolean(record));
    if (selected.length !== uniqueIds.length) throw new Error("所选文档不存在或已被删除");
    return selected;
  }

  async search(documentIds: string[], queries: string[], maxResults = 8): Promise<SearchHit[]> {
    const records = await this.requireRecords(documentIds);
    const resultLimit = Math.min(Math.max(maxResults, 1), 12);
    const cleanQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 6);
    if (cleanQueries.length === 0) throw new Error("至少需要一个搜索词");
    if (cleanQueries.some((query) => query.length > 80)) throw new Error("单个搜索词不能超过 80 个字符");

    const normalizedQueries = cleanQueries.map((query) => ({ raw: query, normalized: normalizeForSearch(query) }));
    const hits: SearchHit[] = [];

    for (const record of records) {
      const document = await this.load(record);
      const matchedLines: Array<{ index: number; matchedQueries: string[] }> = [];

      for (let index = 0; index < document.normalizedLines.length; index += 1) {
        const line = document.normalizedLines[index] ?? "";
        const matchedQueries = normalizedQueries
          .filter((query) => query.normalized && line.includes(query.normalized))
          .map((query) => query.raw);
        if (matchedQueries.length > 0) matchedLines.push({ index, matchedQueries });
      }

      for (const match of matchedLines) {
        const startIndex = Math.max(0, match.index - 3);
        const endIndex = Math.min(document.lines.length - 1, match.index + 3);
        const overlappingHit = hits.find(
          (hit) => hit.documentId === record.id && startIndex + 1 <= hit.endLine && endIndex + 1 >= hit.startLine,
        );
        if (overlappingHit) {
          overlappingHit.startLine = Math.min(overlappingHit.startLine, startIndex + 1);
          overlappingHit.endLine = Math.max(overlappingHit.endLine, endIndex + 1);
          overlappingHit.matchedQueries = [...new Set([...overlappingHit.matchedQueries, ...match.matchedQueries])];
          overlappingHit.excerpt = this.formatLines(
            document.lines,
            overlappingHit.startLine - 1,
            overlappingHit.endLine - 1,
            MAX_SEARCH_EXCERPT_CHARS,
          );
          continue;
        }

        hits.push({
          documentId: record.id,
          documentTitle: record.title,
          startLine: startIndex + 1,
          endLine: endIndex + 1,
          matchedQueries: match.matchedQueries,
          excerpt: this.formatLines(document.lines, startIndex, endIndex, MAX_SEARCH_EXCERPT_CHARS),
        });
      }
    }

    const selected: SearchHit[] = [];
    for (const query of cleanQueries) {
      const candidate = hits
        .filter((hit) => hit.matchedQueries.includes(query) && !selected.includes(hit))
        .sort(compareHits)[0];
      if (candidate) selected.push(candidate);
      if (selected.length >= resultLimit) return selected;
    }

    const remaining = hits
      .filter((hit) => !selected.includes(hit))
      .sort(compareHits);
    return [...selected, ...remaining].slice(0, resultLimit);
  }

  async readLines(documentId: string, startLine: number, endLine: number): Promise<string> {
    const [record] = await this.requireRecords([documentId]);
    if (!record) throw new Error("文档不存在");
    const document = await this.load(record);
    const safeStart = Math.max(1, Math.floor(startLine));
    const safeEnd = Math.min(document.lines.length, Math.floor(endLine));
    if (safeEnd < safeStart) throw new Error("结束行必须大于或等于开始行");
    if (safeEnd - safeStart + 1 > 200) throw new Error("单次最多读取 200 行");
    return this.formatLines(document.lines, safeStart - 1, safeEnd - 1);
  }

  private async readManifest(): Promise<DocumentRecord[]> {
    await this.initialize();
    const raw = await readFile(this.manifestPath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("文档清单格式错误");
    return value as DocumentRecord[];
  }

  private async writeManifest(records: DocumentRecord[]): Promise<void> {
    const temporaryPath = `${this.manifestPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.manifestPath);
  }

  private async load(record: DocumentRecord): Promise<CachedDocument> {
    const path = join(this.documentsDirectory, record.storedName);
    const fileStat = await stat(path);
    const cached = this.cache.get(record.id);
    if (cached?.mtimeMs === fileStat.mtimeMs) return cached;

    const markdown = await readFile(path, "utf8");
    const lines = markdown.split(/\r?\n/);
    const loaded = {
      mtimeMs: fileStat.mtimeMs,
      lines,
      normalizedLines: lines.map(normalizeForSearch),
    };
    this.cache.set(record.id, loaded);
    return loaded;
  }

  private formatLines(
    lines: string[],
    startIndex: number,
    endIndex: number,
    maxCharacters = MAX_TOOL_CHARS,
  ): string {
    const output: string[] = [];
    let totalCharacters = 0;
    for (let index = startIndex; index <= endIndex; index += 1) {
      const rendered = `L${index + 1} | ${lines[index] ?? ""}`;
      if (totalCharacters + rendered.length > maxCharacters) {
        output.push("[内容已按工具输出上限截断]");
        break;
      }
      output.push(rendered);
      totalCharacters += rendered.length;
    }
    return output.join("\n");
  }
}

export { normalizeForSearch };
