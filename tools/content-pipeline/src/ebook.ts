import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import type { JojoTocNode } from "@jojo/content";
import type { DecodedWereadBook, DecodedWereadChapter } from "./models";

type SourceFormat = "epub" | "azw" | "mobi" | "prc";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 16);
}

function cleanText(value: string): string {
  return cheerio.load(value).text().replace(/\s+/g, " ").trim();
}

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function zipPath(baseFile: string, reference: string): { file: string; anchor?: string } {
  const [rawFile, anchor] = reference.split("#", 2);
  const decoded = decodeURIComponent(rawFile ?? "");
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), decoded));
  return { file: file.replace(/^\.\//, ""), ...(anchor ? { anchor: decodeURIComponent(anchor) } : {}) };
}

function xmlValue($: cheerio.CheerioAPI, localName: string): string {
  const match = $("*").filter((_index, element) => (
    element.type === "tag" && element.name.toLowerCase().split(":").at(-1) === localName.toLowerCase()
  )).first();
  return match.text().replace(/\s+/g, " ").trim();
}

function buildNestedToc(
  entries: Array<{ id: string; title: string; level: number; targetId: string; anchorId?: string }>,
): JojoTocNode[] {
  const roots: JojoTocNode[] = [];
  const parents = new Map<number, JojoTocNode>();
  entries.forEach((entry, index) => {
    const node: JojoTocNode = {
      id: entry.id,
      order: index + 1,
      title: entry.title,
      targetId: entry.targetId,
      ...(entry.anchorId ? { anchorId: entry.anchorId } : {}),
    };
    const parent = parents.get(entry.level - 1);
    if (parent) {
      parent.children ??= [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    parents.set(entry.level, node);
    for (const level of [...parents.keys()]) if (level > entry.level) parents.delete(level);
  });
  return roots;
}

interface EpubManifestEntry {
  id: string;
  href: string;
  file: string;
  mediaType: string;
  properties: string[];
}

async function decodeEpub(sourcePath: string, source: Uint8Array): Promise<DecodedWereadBook> {
  const zip = await JSZip.loadAsync(source);
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("EPUB 缺少 META-INF/container.xml");
  const container = cheerio.load(containerXml, { xmlMode: true });
  const opfFile = container("rootfile").first().attr("full-path")?.replace(/^\.\//, "");
  if (!opfFile) throw new Error("EPUB container.xml 没有 OPF 路径");
  const opfXml = await zip.file(opfFile)?.async("string");
  if (!opfXml) throw new Error(`EPUB 缺少包文档 ${opfFile}`);
  const $opf = cheerio.load(opfXml, { xmlMode: true });
  const manifest = $opf("manifest > item").map((_index, element): EpubManifestEntry => {
    const current = $opf(element);
    const href = current.attr("href") ?? "";
    return {
      id: current.attr("id") ?? "",
      href,
      file: zipPath(opfFile, href).file,
      mediaType: current.attr("media-type") ?? "application/octet-stream",
      properties: (current.attr("properties") ?? "").split(/\s+/).filter(Boolean),
    };
  }).get();
  const byId = new Map(manifest.map((entry) => [entry.id, entry]));
  const spine = $opf("spine > itemref").map((_index, element) => byId.get($opf(element).attr("idref") ?? ""))
    .get().filter((entry): entry is EpubManifestEntry => Boolean(entry));
  if (spine.length === 0) throw new Error("EPUB spine 为空，没有可导入正文");

  const embedded = new Map<string, { mediaType: string; url: string }>();
  await Promise.all(manifest.map(async (entry) => {
    if (!/^(?:image|audio|video)\//.test(entry.mediaType)) return;
    const bytes = await zip.file(entry.file)?.async("uint8array");
    if (bytes) embedded.set(entry.file, { mediaType: entry.mediaType, url: dataUrl(entry.mediaType, bytes) });
  }));

  const nav = manifest.find((entry) => entry.properties.includes("nav"));
  const ncx = manifest.find((entry) => entry.mediaType === "application/x-dtbncx+xml");
  const navTitles = new Map<string, string>();
  const navigationEntries: Array<{ reference: string; title: string; level: number; sourceId: string }> = [];
  if (nav) {
    const navXml = await zip.file(nav.file)?.async("string");
    if (navXml) {
      const $nav = cheerio.load(navXml, { xmlMode: true });
      const tocNav = $nav("nav").filter((_index, element) => (
        ($nav(element).attr("epub:type") ?? $nav(element).attr("type") ?? "").split(/\s+/).includes("toc")
      )).first();
      const walk = (list: ReturnType<typeof $nav>, level: number): void => {
        list.children("li").each((index, element) => {
          const li = $nav(element);
          const link = li.children("a[href]").first();
          const reference = link.attr("href");
          const title = link.text().replace(/\s+/g, " ").trim();
          if (reference && title) {
            navigationEntries.push({ reference, title, level, sourceId: `nav-${level}-${index + 1}-${shortHash(reference)}` });
            navTitles.set(zipPath(nav.file, reference).file, title);
          }
          const nested = li.children("ol").first();
          if (nested.length) walk(nested, level + 1);
        });
      };
      const firstList = tocNav.find("ol").first();
      if (firstList.length) walk(firstList, 1);
    }
  } else if (ncx) {
    const ncxXml = await zip.file(ncx.file)?.async("string");
    if (ncxXml) {
      const $ncx = cheerio.load(ncxXml, { xmlMode: true });
      const walk = (points: ReturnType<typeof $ncx>, level: number): void => {
        points.each((index, element) => {
          const point = $ncx(element);
          const reference = point.children("content").first().attr("src");
          const title = point.children("navLabel").first().text().replace(/\s+/g, " ").trim();
          if (reference && title) {
            navigationEntries.push({ reference, title, level, sourceId: point.attr("id") ?? `ncx-${level}-${index + 1}` });
            navTitles.set(zipPath(ncx.file, reference).file, title);
          }
          walk(point.children("navPoint"), level + 1);
        });
      };
      walk($ncx("navMap").children("navPoint"), 1);
    }
  }

  const chapters: DecodedWereadChapter[] = [];
  const chapterIds = new Map<string, string>();
  const errors: Array<Record<string, unknown>> = [];
  for (const [index, entry] of spine.entries()) {
    const raw = await zip.file(entry.file)?.async("string");
    if (!raw) {
      errors.push({ file: entry.file, error: "spine 引用的文件不存在" });
      continue;
    }
    const $ = cheerio.load(raw, { xmlMode: true });
    $("img[src],audio[src],video[src],source[src]").each((_assetIndex, element) => {
      const current = $(element);
      const reference = current.attr("src");
      if (!reference || /^(?:data:|https?:)/i.test(reference)) return;
      const resolved = zipPath(entry.file, reference).file;
      const asset = embedded.get(resolved);
      if (asset) current.attr("src", asset.url);
    });
    $("image").each((_assetIndex, element) => {
      const current = $(element);
      const reference = current.attr("href") ?? current.attr("xlink:href");
      if (!reference) return;
      const asset = embedded.get(zipPath(entry.file, reference).file);
      if (asset) current.replaceWith(`<img src="${asset.url}"/>`);
    });
    const id = `chapter:${shortHash(entry.file)}`;
    chapterIds.set(entry.file, id);
    const title = navTitles.get(entry.file)
      ?? $("h1,h2,h3,h4,h5,h6").first().text().replace(/\s+/g, " ").trim()
      ?? "";
    chapters.push({
      id,
      sourceCid: entry.id,
      sourceFiles: [entry.file],
      title: title || `章节 ${index + 1}`,
      order: index + 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: $.xml(),
    });
  }
  const tocEntries = navigationEntries.flatMap((entry) => {
    const resolved = zipPath(nav?.file ?? ncx?.file ?? opfFile, entry.reference);
    const targetId = chapterIds.get(resolved.file);
    return targetId ? [{
      id: `toc:${entry.sourceId}`,
      title: entry.title,
      level: entry.level,
      targetId,
      ...(resolved.anchor ? { anchorId: resolved.anchor } : {}),
    }] : [];
  });
  const toc = tocEntries.length > 0
    ? buildNestedToc(tocEntries)
    : chapters.map((chapter, index) => ({ id: `toc:${index + 1}`, order: index + 1, title: chapter.title, targetId: chapter.id }));
  const title = xmlValue($opf, "title") || path.basename(sourcePath, path.extname(sourcePath));
  const identifier = xmlValue($opf, "identifier") || `sha256:${sha256(source).slice(0, 24)}`;
  const cover = manifest.find((entry) => entry.properties.includes("cover-image"))
    ?? byId.get($opf("meta[name='cover']").attr("content") ?? "");
  return {
    sourceKind: "epub",
    sourceFormat: "epub",
    sourceDetails: { packagePath: opfFile },
    sourcePath: path.resolve(sourcePath),
    sourceSha256: sha256(source),
    sourceBookId: identifier,
    exportedAt: new Date().toISOString(),
    metadata: {},
    title,
    author: xmlValue($opf, "creator"),
    publisher: xmlValue($opf, "publisher"),
    isbn: xmlValue($opf, "identifier").match(/(?:97[89])?\d{9}[\dX]/i)?.[0] ?? "",
    language: xmlValue($opf, "language") || "zh-CN",
    description: cleanText(xmlValue($opf, "description")),
    ...(cover && embedded.get(cover.file) ? { coverUrl: embedded.get(cover.file)!.url } : {}),
    ...(xmlValue($opf, "date") ? { publishedDate: xmlValue($opf, "date").slice(0, 10) } : {}),
    chapters,
    toc,
    diagnostics: {
      sourceTocItems: navigationEntries.length,
      declaredTocItems: navigationEntries.length,
      missingTocItems: 0,
      sourceChapterRecords: spine.length,
      expectedChapterRecords: spine.length,
      presentChapterRecords: chapters.length,
      missingChapterRecords: errors.length,
      unmatchedChapterRecords: 0,
      duplicateChapterRecords: 0,
      chapterCoverage: spine.length ? chapters.length / spine.length : 0,
      missingChapters: errors.map((error, index) => ({ chapterUid: String(error.file), title: String(error.file), order: index + 1 })),
      matchedChapterRecords: chapters.length,
      decodedChapterRecords: chapters.length,
      failedChapterRecords: errors.length,
      errors,
    },
  };
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export function palmDocDecompress(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < input.length;) {
    const code = input[index++]!;
    if (code === 0) output.push(0);
    else if (code <= 8) {
      output.push(...input.slice(index, index + code));
      index += code;
    } else if (code <= 0x7f) output.push(code);
    else if (code >= 0xc0) output.push(0x20, code ^ 0x80);
    else {
      if (index >= input.length) throw new Error("PalmDOC 回溯标记被截断");
      const pair = (code << 8) | input[index++]!;
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      if (distance === 0 || distance > output.length) throw new Error("PalmDOC 回溯距离无效");
      for (let count = 0; count < length; count += 1) output.push(output[output.length - distance]!);
    }
  }
  return Uint8Array.from(output);
}

function trailingEntrySize(bytes: Uint8Array): number {
  let result = 0;
  for (let index = 0; index < Math.min(4, bytes.length); index += 1) {
    const value = bytes[bytes.length - 1 - index]!;
    result |= (value & 0x7f) << (index * 7);
    if (value & 0x80) return result;
  }
  return result;
}

function trimTrailingData(bytes: Uint8Array, flags: number): Uint8Array {
  let end = bytes.length;
  for (let entries = flags >> 1; entries; entries >>= 1) {
    if (entries & 1) end -= trailingEntrySize(bytes.slice(0, end));
  }
  if ((flags & 1) && end > 0) end -= (bytes[end - 1]! & 3) + 1;
  if (end < 0) throw new Error("MOBI 文本记录尾部数据无效");
  return bytes.slice(0, end);
}

function imageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  const prefix = Buffer.from(bytes.slice(0, 6)).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function exthRecords(record0: Uint8Array): Map<number, Uint8Array[]> {
  const result = new Map<number, Uint8Array[]>();
  if (record0.length < 24 || Buffer.from(record0.slice(16, 20)).toString("ascii") !== "MOBI") return result;
  const headerLength = uint32(record0, 20);
  const flags = record0.length >= 0x84 ? uint32(record0, 0x80) : 0;
  if (!(flags & 0x40)) return result;
  const start = 16 + headerLength;
  if (start + 12 > record0.length || Buffer.from(record0.slice(start, start + 4)).toString("ascii") !== "EXTH") return result;
  const count = uint32(record0, start + 8);
  let offset = start + 12;
  for (let index = 0; index < count && offset + 8 <= record0.length; index += 1) {
    const type = uint32(record0, offset);
    const length = uint32(record0, offset + 4);
    if (length < 8 || offset + length > record0.length) break;
    const values = result.get(type) ?? [];
    values.push(record0.slice(offset + 8, offset + length));
    result.set(type, values);
    offset += length;
  }
  return result;
}

function exthText(records: Map<number, Uint8Array[]>, type: number): string {
  return Buffer.from(records.get(type)?.[0] ?? []).toString("utf8").replace(/\0+$/g, "").trim();
}

async function decodeMobi(sourcePath: string, source: Uint8Array, format: Exclude<SourceFormat, "epub">): Promise<DecodedWereadBook> {
  if (source.length < 86) throw new Error("Kindle/MOBI 文件过短");
  const recordCount = uint16(source, 76);
  const offsets = Array.from({ length: recordCount }, (_unused, index) => uint32(source, 78 + index * 8));
  offsets.push(source.length);
  if (offsets.some((offset, index) => index > 0 && offset < offsets[index - 1]!)) throw new Error("PalmDB 记录表无效");
  const records = offsets.slice(0, -1).map((offset, index) => source.slice(offset, offsets[index + 1]));
  const record0 = records[0];
  if (!record0 || record0.length < 248 || Buffer.from(record0.slice(16, 20)).toString("ascii") !== "MOBI") {
    throw new Error("不是支持的 MOBI/KF7 Kindle 容器");
  }
  const compression = uint16(record0, 0);
  const textLength = uint32(record0, 4);
  const textRecordCount = uint16(record0, 8);
  const encryptionType = uint16(record0, 12);
  const encoding = uint32(record0, 28);
  const mobiVersion = uint32(record0, 36);
  if (encryptionType !== 0) throw new Error(`Kindle 文件已加密或带 DRM（encryptionType=${encryptionType}），导入器不会绕过加密`);
  if (mobiVersion >= 8) throw new Error(`暂不支持 KF8/AZW3（MOBI version ${mobiVersion}）；请先提供 EPUB 或无 DRM 的 MOBI 6/7`);
  if (compression !== 1 && compression !== 2) throw new Error(`不支持的 MOBI 压缩方式 ${compression}`);
  const trailingFlags = record0.length >= 0xf4 ? uint16(record0, 0xf2) : 0;
  const textParts = records.slice(1, textRecordCount + 1).map((record) => {
    const trimmed = trimTrailingData(record!, trailingFlags);
    return compression === 2 ? palmDocDecompress(trimmed) : trimmed;
  });
  const textBytes = Buffer.concat(textParts.map((part) => Buffer.from(part))).subarray(0, textLength);
  const decoder = new TextDecoder(encoding === 65001 ? "utf-8" : encoding === 1252 ? "windows-1252" : "utf-8");
  const recordsExth = exthRecords(record0);
  const firstImageIndex = uint32(record0, 0x6c);
  const imageUrls = new Map<number, string>();
  if (firstImageIndex > 0 && firstImageIndex < records.length) {
    records.slice(firstImageIndex).forEach((bytes, index) => {
      const mediaType = imageMediaType(bytes!);
      if (mediaType) imageUrls.set(index + 1, dataUrl(mediaType, bytes!));
    });
  }
  const text = decoder.decode(textBytes);
  const tocReference = textBytes.toString("utf8").match(/<reference\b[^>]*\btype=["']?toc["']?[^>]*\bfilepos=["']?(\d+)/i)
    ?? textBytes.toString("utf8").match(/<reference\b[^>]*\bfilepos=["']?(\d+)[^>]*\btype=["']?toc/i);
  const tocOffset = tocReference ? Number(tocReference[1]) : textBytes.length;
  const tocHtml = decoder.decode(textBytes.subarray(Math.min(tocOffset, textBytes.length)));
  const $toc = cheerio.load(tocHtml);
  const entries: Array<{ title: string; target: number; level: number }> = [];
  $toc("a[filepos]").each((_index, element) => {
    const current = $toc(element);
    const target = Number(current.attr("filepos"));
    const title = current.text().replace(/\s+/g, " ").trim().replace(/^\d{1,3}[、.．]\s*/, "");
    if (!Number.isSafeInteger(target) || target < 0 || target >= tocOffset || !title) return;
    const level = Math.max(1, current.parents("blockquote").length + 1);
    if (!entries.some((entry) => entry.target === target)) entries.push({ title, target, level });
  });
  entries.sort((left, right) => left.target - right.target);
  if (entries.length === 0) entries.push({ title: exthText(recordsExth, 503) || "正文", target: 0, level: 1 });
  const chapters: DecodedWereadChapter[] = entries.map((entry, index) => {
    const end = entries[index + 1]?.target ?? Math.min(tocOffset, textBytes.length);
    const fragment = decoder.decode(textBytes.subarray(entry.target, end));
    const $ = cheerio.load(`<html><body>${fragment}</body></html>`);
    $("img[recindex]").each((_imageIndex, element) => {
      const current = $(element);
      const url = imageUrls.get(Number(current.attr("recindex")));
      if (url) current.attr("src", url);
      current.removeAttr("recindex");
    });
    return {
      id: `chapter:${shortHash(`${entry.target}:${entry.title}`)}`,
      sourceCid: String(entry.target),
      sourceFiles: [],
      title: entry.title,
      order: index + 1,
      level: entry.level,
      contentType: "application/xhtml+xml",
      content: $.html(),
    };
  });
  const toc = buildNestedToc(entries.map((entry, index) => ({
    id: `toc:${shortHash(`${entry.target}:${entry.title}`)}`,
    title: entry.title,
    level: entry.level,
    targetId: chapters[index]!.id,
  })));
  const titleOffset = uint32(record0, 0x54);
  const titleLength = uint32(record0, 0x58);
  const headerTitle = titleOffset + titleLength <= record0.length
    ? decoder.decode(record0.slice(titleOffset, titleOffset + titleLength)).replace(/\0+$/g, "").trim()
    : "";
  const title = exthText(recordsExth, 503) || headerTitle || path.basename(sourcePath, path.extname(sourcePath));
  const asin = exthText(recordsExth, 113);
  const uniqueId = uint32(record0, 32);
  const coverOffset = recordsExth.get(201)?.[0] && recordsExth.get(201)![0]!.length >= 4
    ? uint32(recordsExth.get(201)![0]!, 0)
    : undefined;
  const coverUrl = coverOffset === undefined ? undefined : imageUrls.get(coverOffset + 1);
  const published = exthText(recordsExth, 106);
  return {
    sourceKind: "kindle",
    sourceFormat: format,
    sourceDetails: { mobiVersion, compression, encryptionType },
    sourcePath: path.resolve(sourcePath),
    sourceSha256: sha256(source),
    sourceBookId: asin || `mobi:${uniqueId}:${sha256(source).slice(0, 12)}`,
    exportedAt: new Date().toISOString(),
    metadata: {},
    title,
    author: exthText(recordsExth, 100),
    publisher: exthText(recordsExth, 101),
    isbn: exthText(recordsExth, 104),
    language: exthText(recordsExth, 524) || "zh-CN",
    description: cleanText(exthText(recordsExth, 103)),
    ...(coverUrl ? { coverUrl } : {}),
    ...(published ? { publishedDate: published.slice(0, 10) } : {}),
    chapters,
    toc,
    diagnostics: {
      sourceTocItems: entries.length,
      declaredTocItems: entries.length,
      missingTocItems: 0,
      sourceChapterRecords: chapters.length,
      expectedChapterRecords: chapters.length,
      presentChapterRecords: chapters.length,
      missingChapterRecords: 0,
      unmatchedChapterRecords: 0,
      duplicateChapterRecords: 0,
      chapterCoverage: 1,
      missingChapters: [],
      matchedChapterRecords: chapters.length,
      decodedChapterRecords: chapters.length,
      failedChapterRecords: 0,
      errors: [],
    },
  };
}

export async function decodeEbookFile(sourcePath: string): Promise<DecodedWereadBook> {
  const source = new Uint8Array(await readFile(sourcePath));
  const extension = path.extname(sourcePath).toLowerCase().slice(1) as SourceFormat;
  if (extension === "epub") return decodeEpub(sourcePath, source);
  if (extension === "azw" || extension === "mobi" || extension === "prc") {
    return decodeMobi(sourcePath, source, extension);
  }
  throw new Error(`不支持的电子书扩展名 .${extension}`);
}

export function isEbookPath(sourcePath: string): boolean {
  return /\.(?:epub|azw|mobi|prc)$/i.test(sourcePath);
}
