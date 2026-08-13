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
    body = body.replace(expression, (_whole, attributes: string, inner: string) => {
      const caption = inner.match(/<figcaption>([\s\S]*?)<\/figcaption>/i)?.[1] ?? "";
      const width = attributes.match(/\bdata-width=["'](\d{1,3})["']/i)?.[1];
      const role = attributes.match(/\bdata-role=["'](signature|cover|full-width|table-image)["']/i)?.[1];
      const alt = asset.alt ?? (role === "cover" ? "封面" : role === "table-image" ? "表格" : "");
      return `<figure${width ? ` data-width="${width}"` : ""}${role ? ` data-role="${role}"` : ""}><img src="../${escapeXml(asset.path)}" alt="${escapeXml(alt)}"/>${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    });
    const inlineExpression = new RegExp(
      `<span[^>]*\\bdata-asset-id=["']${assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*><\\/span>`,
      "gi",
    );
    body = body.replace(
      inlineExpression,
      `<img class="jojo-inline-image" src="../${escapeXml(asset.path)}" alt="${escapeXml(asset.alt ?? "")}"/>`,
    );
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
[data-indent="none"]{text-indent:0}
blockquote{margin:1em 1.5em;font-family:serif}
[data-role="poem"]{margin-left:2em;text-align:left;white-space:pre-wrap}
[data-role="translation"]{opacity:.82}
[data-role="note"]{font-size:.86em;line-height:1.7;text-indent:0}
[data-role="annotation"]{margin-left:1.5em;font-size:.9em;text-indent:0}
[data-role="salutation"]{text-indent:0}
[data-role="attribution"]{text-align:right;text-indent:0}
[data-role="subheading"]{font-weight:bold}
[data-role="aside"]{margin:1em 0;padding:.6em 1em;border-left:2px solid #8b1a1a}
[data-role="highlight"]{padding:.05em .16em;background:#f3eaea}
[data-role="caption"]{text-align:center;text-indent:0;font-size:.8em}
[data-font="kai"]{font-family:KaiTi,STKaiti,serif}
[data-font="fang-song"]{font-family:FangSong,STFangsong,serif}
[data-size="small"]{font-size:.82em}
figure[data-role="signature"]{margin-left:auto}
figure[data-role="cover"]{width:72%;max-width:28em;margin-left:auto;margin-right:auto}
figure[data-role="cover"] img,figure[data-role="full-width"] img,figure[data-role="table-image"] img{width:100%;height:auto}
figure[data-role="full-width"],figure[data-role="table-image"]{width:100%;max-width:100%}
[data-break-before="page"]{break-before:page;page-break-before:always}
figure[data-width="30"]{max-width:30%}figure[data-width="40"]{max-width:40%}figure[data-width="50"]{max-width:50%}
figure[data-width="60"]{max-width:60%}figure[data-width="70"]{max-width:70%}figure[data-width="80"]{max-width:80%}
.jojo-inline-image{display:inline-block;width:auto;height:1em;margin:0 .1em;vertical-align:-.08em}
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
