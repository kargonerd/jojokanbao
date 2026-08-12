import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type {
  JojoAnnotation,
  JojoCanonicalAsset,
  JojoCanonicalChapter,
  JojoTocNode,
} from "@jojo/content";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function flattenToc(nodes: JojoTocNode[]): JojoTocNode[] {
  return nodes.flatMap((node) => [node, ...flattenToc(node.children ?? [])]);
}

function chapterXhtml(
  chapter: JojoCanonicalChapter,
  annotations: JojoAnnotation[],
  assets: Map<string, JojoCanonicalAsset>,
): string {
  let body = chapter.body.value;
  for (const assetId of chapter.assetRefs) {
    const asset = assets.get(assetId);
    if (!asset?.path || asset.type !== "image") continue;
    const expression = new RegExp(
      `<figure([^>]*\\bdata-asset-id=["']${assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*)>([\\s\\S]*?)<\\/figure>`,
      "gi",
    );
    body = body.replace(expression, (_whole, _attributes, inner: string) => {
      const caption = inner.match(/<figcaption>([\s\S]*?)<\/figcaption>/i)?.[1] ?? "";
      return `<figure><img src="../${escapeXml(asset.path)}" alt="${escapeXml(asset.alt ?? "")}"/>${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    });
  }
  const chapterAnnotations = annotations.filter((annotation) => annotation.targetId === chapter.id);
  for (const annotation of chapterAnnotations) {
    const marker = new RegExp(`<sup\\s+data-annotation-id=["']${annotation.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*><\\/sup>`, "gi");
    body = body.replace(marker, `<a epub:type="noteref" href="#${safeId(annotation.id)}">[${escapeXml(annotation.label ?? "注")}]</a>`);
  }
  if (chapterAnnotations.length > 0) {
    body += `<hr/><section>${chapterAnnotations.map((annotation) => (
      `<aside epub:type="footnote" id="${safeId(annotation.id)}"><p>${escapeXml(annotation.body.value)}</p></aside>`
    )).join("")}</section>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title><style>
[data-align="left"]{text-align:left}
[data-align="center"]{text-align:center;text-indent:0}
[data-align="right"]{text-align:right;text-indent:0}
</style></head>
<body><h1>${escapeXml(chapter.title)}</h1>${body}</body></html>`;
}

export async function buildEpub(input: {
  itemId: string;
  title: string;
  language: string;
  author: string;
  chapters: JojoCanonicalChapter[];
  toc: JojoTocNode[];
  annotations: JojoAnnotation[];
  assets: JojoCanonicalAsset[];
  canonicalDatasetDirectory: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  const chapterNames = new Map(
    input.chapters.map((chapter, index) => [chapter.id, `chapters/chapter-${String(index + 1).padStart(4, "0")}.xhtml`]),
  );
  const assetMap = new Map(input.assets.map((asset) => [asset.id, asset]));
  for (const chapter of input.chapters) {
    zip.file(`OEBPS/${chapterNames.get(chapter.id)!}`, chapterXhtml(chapter, input.annotations, assetMap));
  }
  for (const asset of input.assets) {
    if (!asset.path || asset.type !== "image") continue;
    zip.file(`OEBPS/${asset.path}`, await readFile(path.join(input.canonicalDatasetDirectory, asset.path)));
  }
  const tocEntries = flattenToc(input.toc)
    .filter((node) => node.targetId && chapterNames.has(node.targetId))
    .map((node) => `<li><a href="${chapterNames.get(node.targetId!)}${node.anchorId ? `#${escapeXml(node.anchorId)}` : ""}">${escapeXml(node.title)}</a></li>`)
    .join("");
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(input.language)}">
<head><meta charset="utf-8"/><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${tocEntries}</ol></nav></body></html>`);
  const chapterManifest = input.chapters.map((chapter, index) => (
    `<item id="chapter-${index + 1}" href="${chapterNames.get(chapter.id)}" media-type="application/xhtml+xml"/>`
  )).join("");
  const assetManifest = input.assets.filter((asset) => asset.path && asset.type === "image")
    .map((asset, index) => `<item id="asset-${index + 1}" href="${escapeXml(asset.path)}" media-type="${escapeXml(asset.mediaType)}"/>`)
    .join("");
  const spine = input.chapters.map((_chapter, index) => `<itemref idref="chapter-${index + 1}"/>`).join("");
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(input.language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${escapeXml(input.itemId)}</dc:identifier><dc:title>${escapeXml(input.title)}</dc:title><dc:language>${escapeXml(input.language)}</dc:language>${input.author ? `<dc:creator>${escapeXml(input.author)}</dc:creator>` : ""}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapterManifest}${assetManifest}</manifest>
<spine>${spine}</spine></package>`);
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
}
