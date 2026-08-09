import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JojoTocNode } from "@jojo/content";
import type {
  DecodedWereadBook,
  DecodedWereadChapter,
  WereadChapterRecord,
  WereadRawExport,
  WereadTocEntry,
} from "./models";

const ENDPOINTS = {
  epub: [
    "/web/book/chapter/e_0",
    "/web/book/chapter/e_1",
    "/web/book/chapter/e_3",
  ],
  text: [
    "/web/book/chapter/t_0",
    "/web/book/chapter/t_1",
  ],
} as const;

function calculateSwapIndexes(value: string): number[] {
  if (value.length < 4) return [];
  if (value.length < 11) return [0, 2];
  const tailLength = Math.min(4, Math.ceil(value.length / 10));
  let encodedIndexes = "";
  for (let index = value.length - 1; index >= value.length - tailLength; index -= 1) {
    encodedIndexes += Number.parseInt(value.charCodeAt(index).toString(2), 4).toString();
  }
  const indexes: number[] = [];
  const modulo = value.length - tailLength - 2;
  const step = modulo.toString().length;
  for (let index = 0; indexes.length < 10 && index + step < encodedIndexes.length; index += step) {
    indexes.push(Number.parseInt(encodedIndexes.slice(index, index + step), 10) % modulo);
    indexes.push(Number.parseInt(encodedIndexes.slice(index + 1, index + 1 + step), 10) % modulo);
  }
  return indexes;
}

function undoCharacterSwaps(value: string, indexes: number[]): string {
  const characters = [...value];
  for (let index = indexes.length - 1; index >= 0; index -= 2) {
    for (const offset of [1, 0]) {
      const left = indexes[index]! + offset;
      const right = indexes[index - 1]! + offset;
      [characters[left], characters[right]] = [characters[right]!, characters[left]!];
    }
  }
  return characters.join("");
}

export function decodeWereadParts(parts: string[]): string {
  if (parts.length === 0 || parts.some((part) => typeof part !== "string")) {
    throw new Error("章节响应分片不完整");
  }
  const joined = parts.map((part) => part.slice(32)).join("").slice(1);
  const restored = undoCharacterSwaps(joined, calculateSwapIndexes(joined));
  const normalized = restored
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .replace(/[^A-Za-z0-9+/]/g, "");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function chapterEncoding(chapter: WereadChapterRecord): "epub" | "text" | undefined {
  if (ENDPOINTS.epub.every((endpoint) => typeof chapter[endpoint] === "string")) return "epub";
  if (ENDPOINTS.text.every((endpoint) => typeof chapter[endpoint] === "string")) return "text";
  return undefined;
}

export function decodeWereadChapter(chapter: WereadChapterRecord): {
  content: string;
  contentType: "application/xhtml+xml" | "text/plain";
} {
  const encoding = chapterEncoding(chapter);
  if (!encoding) throw new Error("找不到完整的 EPUB 或 TXT 章节分片");
  return {
    content: decodeWereadParts(ENDPOINTS[encoding].map((endpoint) => chapter[endpoint] as string)),
    contentType: encoding === "epub" ? "application/xhtml+xml" : "text/plain",
  };
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

export function hashWereadId(input: string | number): string {
  const data = String(input);
  const dataMd5 = md5(data);
  let result = `${dataMd5.slice(0, 3)}${/^\d*$/.test(data) ? "3" : "4"}2${dataMd5.slice(-2)}`;
  const parts = /^\d*$/.test(data)
    ? [...data.matchAll(/.{1,9}/g)].map((match) => Number.parseInt(match[0], 10).toString(16))
    : [[...data].map((character) => character.charCodeAt(0).toString(16)).join("")];
  parts.forEach((part, index) => {
    result += part.length.toString(16).padStart(2, "0") + part;
    if (index < parts.length - 1) result += "g";
  });
  if (result.length < 20) result += dataMd5.slice(0, 20 - result.length);
  return result + md5(result).slice(0, 3);
}

function metadata(raw: WereadRawExport): Record<string, unknown> {
  const value = raw.meta;
  if (!value || typeof value !== "object") return {};
  const data = value.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    const first = data[0] as Record<string, unknown>;
    return first.book && typeof first.book === "object"
      ? first.book as Record<string, unknown>
      : first;
  }
  return value.book && typeof value.book === "object"
    ? value.book as Record<string, unknown>
    : value;
}

function isoDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function publishedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

export function isWereadExport(value: unknown): value is WereadRawExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as WereadRawExport;
  return Boolean(
    raw.bookId
    && raw.meta
    && Array.isArray(raw.toc)
    && Array.isArray(raw.chapters)
    && (!raw.site || raw.site.includes("weread.qq.com")),
  );
}

function tocTargetMap(
  sourceToc: WereadTocEntry[],
  chaptersByUid: Map<string, DecodedWereadChapter>,
): Map<number, { targetId: string; anchorId?: string }> {
  const result = new Map<number, { targetId: string; anchorId?: string }>();
  const byFile = new Map<string, DecodedWereadChapter>();
  for (const chapter of chaptersByUid.values()) {
    for (const file of chapter.sourceFiles) byFile.set(file, chapter);
  }
  let previous: DecodedWereadChapter | undefined;
  sourceToc.forEach((entry, index) => {
    const direct = entry.chapterUid === undefined
      ? undefined
      : chaptersByUid.get(String(entry.chapterUid));
    const fileMatch = entry.files?.map((file) => byFile.get(file)).find(Boolean);
    const target = direct ?? fileMatch ?? previous;
    if (target) {
      result.set(index, { targetId: target.id });
      previous = target;
    }
  });
  return result;
}

function buildToc(
  sourceToc: WereadTocEntry[],
  chaptersByUid: Map<string, DecodedWereadChapter>,
): JojoTocNode[] {
  const targets = tocTargetMap(sourceToc, chaptersByUid);
  const roots: JojoTocNode[] = [];
  const parentAtLevel = new Map<number, JojoTocNode>();
  let order = 0;
  sourceToc.forEach((entry, index) => {
    const level = Math.max(1, Number(entry.level) || 1);
    const sourceId = String(entry.chapterUid ?? `index-${index + 1}`);
    const target = targets.get(index);
    const node: JojoTocNode = {
      id: `toc:${sourceId}`,
      order: ++order,
      title: String(entry.title || `目录 ${index + 1}`),
      ...(target ?? {}),
    };
    const parent = parentAtLevel.get(level - 1);
    if (parent) {
      parent.children ??= [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    parentAtLevel.set(level, node);
    for (const known of [...parentAtLevel.keys()]) {
      if (known > level) parentAtLevel.delete(known);
    }
    for (const [anchorIndex, anchor] of (entry.anchors ?? []).entries()) {
      if (!target?.targetId || !anchor.anchor) continue;
      node.children ??= [];
      node.children.push({
        id: `toc:${sourceId}:anchor-${anchorIndex + 1}`,
        order: ++order,
        title: String(anchor.title || `小节 ${anchorIndex + 1}`),
        targetId: target.targetId,
        anchorId: String(anchor.anchor).replace(/^#/, ""),
      });
    }
  });
  return roots;
}

export async function decodeWereadFile(sourcePath: string): Promise<DecodedWereadBook> {
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const parsed = JSON.parse(source.toString("utf8")) as unknown;
  if (!isWereadExport(parsed)) throw new Error("不是支持的微信读书 JSON 导出");
  const raw = parsed;
  const bookMetadata = metadata(raw);
  const sourceBookId = String(raw.bookId ?? bookMetadata.bookId ?? "");
  const sourceToc = raw.toc ?? [];
  const tocByCid = new Map<string, WereadTocEntry>();
  for (const entry of sourceToc) {
    if (entry.chapterUid !== undefined) tocByCid.set(hashWereadId(entry.chapterUid), entry);
  }
  const errors: Array<Record<string, unknown>> = [];
  const decoded: DecodedWereadChapter[] = [];
  for (const [sourceIndex, record] of (raw.chapters ?? []).entries()) {
    const cid = String(record.cid ?? "");
    const tocEntry = tocByCid.get(cid);
    try {
      const chapter = decodeWereadChapter(record);
      const uid = tocEntry?.chapterUid === undefined ? undefined : String(tocEntry.chapterUid);
      decoded.push({
        id: `chapter:${uid ?? `cid-${cid || sourceIndex + 1}`}`,
        sourceCid: cid,
        ...(uid ? { sourceChapterUid: uid } : {}),
        sourceFiles: Array.isArray(tocEntry?.files) ? tocEntry.files : [],
        title: String(tocEntry?.title || `未匹配章节 ${sourceIndex + 1}`),
        order: Number(tocEntry?.chapterIdx) || sourceToc.length + sourceIndex + 1,
        level: Number(tocEntry?.level) || 1,
        contentType: chapter.contentType,
        content: chapter.content,
      });
    } catch (error) {
      errors.push({
        cid,
        chapterId: tocEntry?.chapterUid ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  decoded.sort((left, right) => left.order - right.order);
  const byUid = new Map(
    decoded.filter((chapter) => chapter.sourceChapterUid)
      .map((chapter) => [chapter.sourceChapterUid!, chapter]),
  );
  return {
    sourcePath: path.resolve(sourcePath),
    sourceSha256,
    sourceBookId,
    ...(raw.bid ? { sourceBid: raw.bid } : {}),
    exportedAt: isoDate(raw.date) ?? new Date().toISOString(),
    metadata: bookMetadata,
    title: String(bookMetadata.title || path.basename(sourcePath, path.extname(sourcePath))),
    author: String(bookMetadata.author || ""),
    publisher: String(bookMetadata.publisher || ""),
    isbn: String(bookMetadata.isbn || ""),
    language: bookMetadata.isTraditionalChinese ? "zh-Hant" : "zh-CN",
    description: String(bookMetadata.intro || ""),
    ...(typeof bookMetadata.cover === "string" && bookMetadata.cover
      ? { coverUrl: bookMetadata.cover }
      : {}),
    ...(publishedDate(bookMetadata.publishTime)
      ? { publishedDate: publishedDate(bookMetadata.publishTime) }
      : {}),
    chapters: decoded,
    toc: buildToc(sourceToc, byUid),
    diagnostics: {
      sourceTocItems: sourceToc.length,
      sourceChapterRecords: raw.chapters?.length ?? 0,
      matchedChapterRecords: decoded.filter((chapter) => chapter.sourceChapterUid).length,
      decodedChapterRecords: decoded.length,
      failedChapterRecords: errors.length,
      errors,
    },
  };
}
