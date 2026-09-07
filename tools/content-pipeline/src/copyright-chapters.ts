import type { JojoTocNode } from "@jojo/content";
import path from "node:path";
import * as cheerio from "cheerio";
import JSZip from "jszip";

/** Only dedicated copyright pages; discussion of copyright remains content. */
export function isCopyrightChapterTitle(title: string): boolean {
  return /^(?:版权信息|版權信息|版权页|版權頁)$/u.test(title.normalize("NFKC").replace(/\s/gu, ""));
}

export function removeCopyrightToc(nodes: JojoTocNode[], removedIds: Set<string>): JojoTocNode[] {
  return nodes.flatMap((node) => {
    const children = removeCopyrightToc(node.children ?? [], removedIds);
    if (isCopyrightChapterTitle(node.title)) return children;
    if (node.targetId && removedIds.has(node.targetId)) {
      if (!children.length) return [];
      const { targetId: _targetId, anchorId: _anchorId, ...parent } = node;
      return [{ ...parent, children }];
    }
    return [{ ...node, ...(node.children ? { children } : {}) }];
  });
}

/** Patch an existing pipeline EPUB without reimporting or renumbering its chapters. */
export async function removeCopyrightEpubChapters(
  bytes: Uint8Array,
  chapters: Array<{ id: string; title: string }>,
  removedIds: Set<string>,
  modifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (!container) throw new Error("EPUB container is missing");
  const packagePath = cheerio.load(container, { xmlMode: true })("rootfile").attr("full-path");
  const packageXml = packagePath && await zip.file(packagePath)?.async("string");
  if (!packagePath || !packageXml) throw new Error("EPUB package is missing");
  const $ = cheerio.load(packageXml, { xmlMode: true });
  const spine = $("spine > itemref").toArray();
  if (spine.length !== chapters.length) throw new Error("EPUB spine differs from the published chapter list");
  const removedFiles = new Set<string>();
  for (const [index, chapter] of chapters.entries()) {
    if (!removedIds.has(chapter.id)) continue;
    if (!isCopyrightChapterTitle(chapter.title)) throw new Error(`Refusing to remove ordinary chapter ${chapter.id}`);
    const reference = $(spine[index]!);
    const entry = $("manifest > item").filter((_index, element) => $(element).attr("id") === reference.attr("idref"));
    const href = entry.attr("href");
    if (!href) throw new Error(`EPUB chapter entry is missing: ${chapter.id}`);
    const file = path.posix.join(path.posix.dirname(packagePath), href);
    const xhtml = await zip.file(file)?.async("string");
    if (!xhtml || cheerio.load(xhtml, { xmlMode: true })("title").first().text() !== chapter.title) {
      throw new Error(`EPUB chapter title differs from the published chapter list: ${chapter.id}`);
    }
    removedFiles.add(file);
    reference.remove();
    entry.remove();
    zip.remove(file);
  }
  for (const entry of $("manifest > item[properties~='nav']").toArray()) {
    const navPath = path.posix.join(path.posix.dirname(packagePath), $(entry).attr("href")!);
    const navXml = await zip.file(navPath)?.async("string");
    if (!navXml) throw new Error("EPUB navigation is missing");
    const $nav = cheerio.load(navXml, { xmlMode: true });
    $nav("a[href]").each((_index, element) => {
      const anchor = $nav(element);
      const href = anchor.attr("href")!.split("#")[0]!;
      if (!removedFiles.has(path.posix.join(path.posix.dirname(navPath), href))) return;
      const listItem = anchor.closest("li");
      const children = listItem.children("ol,ul").children("li");
      if (children.length) listItem.replaceWith(children);
      else if (listItem.length) listItem.remove();
      else anchor.remove();
    });
    zip.file(navPath, $nav.xml());
  }
  $("metadata > meta[property='dcterms:modified']").text(modifiedAt);
  zip.file(packagePath, $.xml());
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
}
