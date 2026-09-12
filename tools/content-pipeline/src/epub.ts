import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
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

function chapterXhtml(
  chapter: JojoCanonicalChapter,
  annotations: JojoAnnotation[],
  assets: Map<string, JojoCanonicalAsset>,
  chapterNames: Map<string, string>,
  language: string,
): string {
  // Parse as HTML here so semantic empty containers such as span/figure are
  // expanded instead of serialized as XML self-closing elements.
  const $body = cheerio.load(`<html><body>${chapter.body.value}</body></html>`);
  $body("a[data-target-id]").each((_index, element) => {
    const current = $body(element);
    const targetId = current.attr("data-target-id") ?? "";
    const targetFile = chapterNames.get(targetId);
    if (!targetFile) return;
    const originalAnchor = current.attr("data-anchor-id");
    const anchorId = annotations.some((note) => note.id === originalAnchor && note.targetId === targetId)
      ? safeId(originalAnchor!) : originalAnchor;
    const fragment = anchorId ? `#${encodeURIComponent(anchorId)}` : "";
    const href = targetId === chapter.id
      ? (fragment || "#")
      : `${path.posix.basename(targetFile)}${fragment}`;
    current.attr("href", href).removeAttr("data-target-id").removeAttr("data-anchor-id");
  });
  const assetRefs = new Set(chapter.assetRefs);
  // Older canonical HTML can put prose and further figures inside an image
  // placeholder. Work from the inside out; replacing its inner HTML loses text
  // and a regex cannot match the closing tag of a nested figure reliably.
  for (const element of $body("figure[data-asset-id], span[data-asset-id]").toArray().reverse()) {
    const current = $body(element);
    const assetId = current.attr("data-asset-id")!;
    const asset = assetRefs.has(assetId) ? assets.get(assetId) : undefined;
    if (!asset?.path || asset.type !== "image") continue;
    const role = current.attr("data-role");
    const image = $body("<img>").attr("src", `../${asset.path}`)
      .attr("alt", asset.alt ?? (role === "cover" ? "封面" : role === "table-image" ? "表格" : ""));
    if (element.name === "span") {
      image.addClass("jojo-inline-image");
      if (current.contents().length === 0) {
        if (current.attr("id")) image.attr("id", current.attr("id")!);
        current.replaceWith(image);
      } else {
        current.prepend(image);
      }
      continue;
    }
    const children = current.contents().toArray();
    const proseStart = children.findIndex((node) => (
      !(node.type === "text" && !node.data.trim()) &&
      !(node.type === "tag" && node.name === "figcaption")
    ));
    if (proseStart !== -1) {
      const following = children.slice(proseStart);
      for (const node of following) {
        // A caption after prose must stay in that position, outside the figure.
        if (node.type === "tag" && node.name === "figcaption") {
          node.name = "p";
          $body(node).attr("data-role", "caption");
        }
      }
      current.after(following);
    }
    current.prepend(image);
  }
  const chapterAnnotations = annotations.filter((annotation) => annotation.targetId === chapter.id);
  const annotationIds = new Set(chapterAnnotations.map((annotation) => annotation.id));
  $body('a[href^="#"]').each((_index, element) => {
    const current = $body(element);
    let anchor: string;
    try { anchor = decodeURIComponent(current.attr("href")!.slice(1)); }
    catch { return; }
    if (annotationIds.has(anchor)) current.attr("href", `#${safeId(anchor)}`);
  });
  if (chapterAnnotations.length > 0) {
    $body("body").append(`<hr/><section>${chapterAnnotations.map((annotation) => (
      `<aside epub:type="footnote" id="${safeId(annotation.id)}"><p>${escapeXml(annotation.body.value)}</p></aside>`
    )).join("")}</section>`);
  }
  // Canonical bodies are HTML, while EPUB requires well-formed XHTML (including
  // closed br/hr/img elements and XML-safe entities).
  const annotationMap = new Map(chapterAnnotations.map((annotation) => [annotation.id, annotation]));
  $body("sup[data-annotation-id]").each((_index, element) => {
    const current = $body(element);
    const annotation = annotationMap.get(current.attr("data-annotation-id")!);
    if (!annotation) return;
    current.parents("a").each((_parentIndex, parent) => {
      parent.name = "span";
      $body(parent).removeAttr("href").removeAttr("data-target-id").removeAttr("data-anchor-id");
    });
    const link = $body("<a></a>").attr("epub:type", "noteref")
      .attr("href", `#${safeId(annotation.id)}`).text(`[${annotation.label ?? "注"}]`);
    if (current.attr("id")) link.attr("id", current.attr("id")!);
    current.after(current.contents().toArray());
    current.replaceWith(link);
  });
  const body = $body.html($body("body").contents().toArray(), { xml: true });
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}">
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title><style>
[data-align="left"]{text-align:left}
[data-align="center"]{text-align:center;text-indent:0}
[data-align="right"]{text-align:right;text-indent:0}
[data-indent="none"]{text-indent:0}
blockquote{margin:1em 1.5em;font-family:serif}
table{width:100%;border-collapse:collapse;margin:1em 0;break-inside:avoid}
th,td{border:1px solid #999;padding:.4em .6em;text-indent:0;text-align:left}
math[display="block"]{margin:1em 0;max-width:100%;overflow-x:auto;text-indent:0}
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
    zip.file(`OEBPS/${chapterNames.get(chapter.id)!}`, chapterXhtml(chapter, input.annotations, assetMap, chapterNames, input.language));
  }
  for (const asset of input.assets) {
    if (!asset.path || asset.type !== "image") continue;
    zip.file(`OEBPS/${asset.path}`, await readFile(path.join(input.canonicalDatasetDirectory, asset.path)));
  }
  const renderToc = (nodes: JojoTocNode[]): string => nodes.map((node) => {
    const file = node.targetId ? chapterNames.get(node.targetId) : undefined;
    const children = renderToc(node.children ?? []);
    if (!file && !children) return "";
    const label = file
      ? `<a href="${file}${node.anchorId ? `#${escapeXml(encodeURIComponent(node.anchorId))}` : ""}">${escapeXml(node.title)}</a>`
      : `<span>${escapeXml(node.title)}</span>`;
    return `<li>${label}${children ? `<ol>${children}</ol>` : ""}</li>`;
  }).join("");
  const tocEntries = renderToc(input.toc);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(input.language)}">
<head><meta charset="utf-8"/><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${tocEntries}</ol></nav></body></html>`);
  const chapterManifest = input.chapters.map((chapter, index) => (
    `<item id="chapter-${index + 1}" href="${chapterNames.get(chapter.id)}" media-type="application/xhtml+xml"${/<math\b/i.test(chapter.body.value) ? ' properties="mathml"' : ""}/>`
  )).join("");
  const assetManifest = input.assets.filter((asset) => asset.path && asset.type === "image")
    .map((asset, index) => `<item id="asset-${index + 1}" href="${escapeXml(asset.path)}" media-type="${escapeXml(asset.mediaType)}"${asset.role === "cover" ? ' properties="cover-image"' : ""}/>`)
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
