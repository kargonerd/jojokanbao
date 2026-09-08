import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { bookSearchIndex, buildContentPipeline, convertWereadChapter, decodeEbookFile } from "../src";
import { buildEpub } from "../src/epub";
import { validatePipelineOutput } from "../src/validate-output";
import type { JojoCanonicalItem } from "@jojo/content";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Entry { id: string; file: string; body?: string; mediaType?: string; properties?: string }
async function fixture(options: {
  entries?: Entry[];
  spine?: string[];
  nav?: string;
  ncx?: string;
  prefixed?: boolean;
  metadata?: string;
  files?: Record<string, string | Uint8Array>;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "jojo-epub-import-"));
  directories.push(directory);
  const zip = new JSZip();
  const entries = options.entries ?? [{ id: "c1", file: "text/ch1.xhtml", body: "<h1>第一章</h1><p>第一章正文。</p>" }];
  const opfPrefix = options.prefixed ? "opf:" : "";
  const containerPrefix = options.prefixed ? "ocf:" : "";
  const tag = (name: string) => `${opfPrefix}${name}`;
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<${containerPrefix}container xmlns${options.prefixed ? ":ocf" : ""}="urn:oasis:names:tc:opendocument:xmlns:container"><${containerPrefix}rootfiles><${containerPrefix}rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></${containerPrefix}rootfiles></${containerPrefix}container>`);
  const allEntries = [...entries];
  if (options.nav !== undefined) allEntries.push({ id: "nav", file: "nav.xhtml", properties: "nav" });
  if (options.ncx !== undefined) allEntries.push({ id: "ncx", file: "toc.ncx", mediaType: "application/x-dtbncx+xml" });
  zip.file("OPS/package.opf", `<${tag("package")} xmlns${options.prefixed ? ":opf" : ""}="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="uid" version="3.0"><${tag("metadata")}><dc:title>导入测试书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh-CN</dc:language>${options.metadata ?? '<dc:identifier id="uid">test-book</dc:identifier>'}</${tag("metadata")}><${tag("manifest")}>${allEntries.map((entry) => `<${tag("item")} id="${entry.id}" href="${encodeURI(entry.file)}" media-type="${entry.mediaType ?? "application/xhtml+xml"}"${entry.properties ? ` properties="${entry.properties}"` : ""}/>`).join("")}</${tag("manifest")}><${tag("spine")} toc="ncx">${(options.spine ?? entries.filter((entry) => entry.body !== undefined).map((entry) => entry.id)).map((id) => `<${tag("itemref")} idref="${id}"/>`).join("")}</${tag("spine")}></${tag("package")}>`);
  for (const entry of entries) {
    if (entry.body !== undefined) zip.file(`OPS/${entry.file}`, `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${entry.body}</body></html>`);
  }
  if (options.nav !== undefined) zip.file("OPS/nav.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${options.nav}</ol></nav></body></html>`);
  if (options.ncx !== undefined) zip.file("OPS/toc.ncx", `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${options.ncx}</navMap></ncx>`);
  for (const [file, content] of Object.entries(options.files ?? {})) zip.file(file, content);
  const file = path.join(directory, "fixture.epub");
  await writeFile(file, await zip.generateAsync({ type: "uint8array" }));
  return { file, directory };
}

describe("EPUB import compatibility and integrity", () => {
  it("reads namespace-prefixed package documents and uses the declared unique identifier", async () => {
    const { file } = await fixture({ prefixed: true, metadata: '<dc:identifier>9781234567890</dc:identifier><dc:identifier id="uid">urn:uuid:actual-book</dc:identifier>' });
    const decoded = await decodeEbookFile(file);
    expect(decoded).toMatchObject({ title: "导入测试书", author: "测试作者", sourceBookId: "urn:uuid:actual-book" });
    expect(decoded.chapters).toHaveLength(1);
  });

  it("preserves EPUB 2 NCX hierarchy, reading order, and encoded Chinese filenames", async () => {
    const { file } = await fixture({
      entries: [{ id: "c2", file: "text/第二章.xhtml", body: "<p>乙章正文</p>" }, { id: "c1", file: "text/第一章.xhtml", body: '<section id="节一"><h1>第一章</h1><p>甲章正文</p></section>' }],
      spine: ["c1", "c2"],
      ncx: '<navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml"/><navPoint id="n2"><navLabel><text>第一节</text></navLabel><content src="text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml#%E8%8A%82%E4%B8%80"/></navPoint></navPoint><navPoint id="n3"><navLabel><text>第二章</text></navLabel><content src="text/第二章.xhtml"/></navPoint>',
    });
    const decoded = await decodeEbookFile(file);
    expect(decoded.chapters.map((chapter) => chapter.title)).toEqual(["第一章", "第二章"]);
    expect(decoded.toc[0]?.children?.[0]).toMatchObject({ title: "第一节", anchorId: "节一" });
    expect(convertWereadChapter(decoded.chapters[0]!, []).chapter.body.value).toContain('id="节一"');
  });

  it("keeps non-clickable EPUB 3 TOC groups and falls back to NCX when nav has no TOC", async () => {
    const { file } = await fixture({ nav: '<li><span>第一卷</span><ol><li><a href="text/ch1.xhtml">第一章</a></li></ol></li>' });
    const decoded = await decodeEbookFile(file);
    expect(decoded.toc[0]).toMatchObject({ title: "第一卷", children: [{ title: "第一章", targetId: decoded.chapters[0]!.id }] });
    const fallback = await fixture({ nav: "", ncx: '<navPoint id="chapter"><navLabel><text>NCX 章节</text></navLabel><content src="text/ch1.xhtml"/></navPoint>' });
    expect((await decodeEbookFile(fallback.file)).toc[0]?.title).toBe("NCX 章节");
  });

  it("converts same-page footnotes and manifest-only endnotes without losing unused notes", async () => {
    const { file } = await fixture({
      entries: [
        { id: "c1", file: "text/ch1.xhtml", body: '<p>甲文<a epub:type="noteref" href="#fn1"><sup>①</sup></a>乙文<a role="doc-noteref" href="notes.xhtml#en2">*</a></p><aside epub:type="footnote" id="fn1"><p>同页注释<a epub:type="backlink" href="#ref1">返回</a></p></aside><aside epub:type="footnote" id="unused"><p>未引用的注释也要保留</p></aside>' },
        { id: "notes", file: "text/notes.xhtml", body: '<section epub:type="endnotes"><h1>注释</h1><aside epub:type="endnote" id="en2"><p>独立文件尾注<a role="doc-backlink" href="ch1.xhtml#ref2">返回</a></p></aside></section>' },
      ],
      spine: ["c1"],
    });
    const decoded = await decodeEbookFile(file);
    const converted = convertWereadChapter(decoded.chapters[0]!, []);
    expect(converted.annotations).toMatchObject([{ label: "①", body: { value: "同页注释" } }, { label: "*", body: { value: "独立文件尾注" } }]);
    expect(converted.chapter.body.value).toContain("未引用的注释也要保留");
    expect(converted.chapter.body.value).not.toContain("同页注释");
    expect(decoded.diagnostics.errors).toEqual([]);
  });

  it("rejects unknown spine references instead of silently importing an incomplete book", async () => {
    const { file, directory } = await fixture({ spine: ["c1", "missing-id"] });
    const report = await buildContentPipeline({ inputPaths: [file], outputDirectory: path.join(directory, "build") });
    expect(report).toMatchObject({ acceptedFiles: 0, rejectedFiles: 1, items: 0 });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringMatching(/missing-id/) }));
  });

  it.each(["text/missing.xhtml", "text/ch1.xhtml#missing-anchor"])("reports a broken TOC target: %s", async (target) => {
    const { file, directory } = await fixture({ nav: `<li><a href="${target}">丢失章节</a></li>` });
    const report = await buildContentPipeline({ inputPaths: [file], outputDirectory: path.join(directory, "build") });
    expect(report).toMatchObject({ acceptedFiles: 0, rejectedFiles: 1 });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "source-toc-truncated" }));
  });

  it("reports a missing embedded image instead of silently dropping it", async () => {
    const { file, directory } = await fixture({ entries: [{ id: "c1", file: "text/ch1.xhtml", body: '<p>有插图的正文</p><img src="../images/missing.png" alt="重要图示"/>' }] });
    const report = await buildContentPipeline({ inputPaths: [file], outputDirectory: path.join(directory, "build") });
    expect(report).toMatchObject({ acceptedFiles: 0, rejectedFiles: 1 });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "epub-assets-unresolved" }));
  });

  it("preserves table cells and MathML from PDF converters in content and search", async () => {
    const { file } = await fixture({ entries: [{ id: "c1", file: "chapter.xhtml", body: '<h1>表格与公式</h1><table id="data"><caption>统计表</caption><thead><tr><th scope="col">地区</th><th>数量</th></tr></thead><tbody><tr><td rowspan="2">华东</td><td>42</td></tr><tr><td>18</td></tr></tbody></table><p>分式：<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>x</mi><mn>2</mn></mfrac></math></p><math xmlns="http://www.w3.org/1998/Math/MathML" display="block" onclick="bad()"><msup><mi>y</mi><mn>2</mn></msup><mtext>公式标识</mtext><script>bad()</script></math>' }] });
    const decoded = await decodeEbookFile(file);
    const converted = convertWereadChapter(decoded.chapters[0]!, []);
    const $ = cheerio.load(converted.chapter.body.value);
    expect($("table td").map((_index, element) => $(element).text()).get()).toEqual(["华东", "42", "18"]);
    expect($("td[rowspan]").attr("rowspan")).toBe("2");
    expect($("math mfrac mi").text()).toBe("x");
    expect($("math msup mn").text()).toBe("2");
    expect(converted.chapter.body.value).not.toMatch(/onclick|script|bad\(\)/);
    const search = bookSearchIndex({ itemId: "test", chapters: [converted.chapter] });
    expect(search.blocks.some((block) => block.text === "华东")).toBe(true);
    expect(search.blocks.some((block) => block.text.includes("公式标识"))).toBe(true);
  });

  it("rejects a missing spine file by default and reports an explicit partial import", async () => {
    const { file, directory } = await fixture({ entries: [{ id: "c1", file: "text/ch1.xhtml", body: "<p>现存正文</p>" }, { id: "missing", file: "missing.xhtml" }], spine: ["c1", "missing"] });
    const strict = await buildContentPipeline({ inputPaths: [file], outputDirectory: path.join(directory, "strict") });
    expect(strict).toMatchObject({ acceptedFiles: 0, rejectedFiles: 1 });
    const partial = await buildContentPipeline({ inputPaths: [file], outputDirectory: path.join(directory, "partial"), allowPartial: true });
    expect(partial).toMatchObject({ acceptedFiles: 1, chapters: 1 });
    expect(partial.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", code: "source-chapters-missing" }));
  });

  it("rejects corrupt ZIP input with a source diagnostic", async () => {
    const { file, directory } = await fixture();
    await writeFile(file, "not a ZIP archive");
    const report = await buildContentPipeline({ inputPaths: [file], outputDirectory: path.join(directory, "build") });
    expect(report).toMatchObject({ acceptedFiles: 0, rejectedFiles: 1 });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "invalid-source" }));
  });

  it("removes converted notes-only TOC entries but preserves rich notes as linked content", async () => {
    const plain = await fixture({
      entries: [{ id: "c1", file: "chapter.xhtml", body: '<p>正文<a href="notes.xhtml#fn1">1</a></p>' }, { id: "notes", file: "notes.xhtml", body: '<section><h1>注释</h1><aside epub:type="footnote" id="fn1"><p>注释正文</p></aside></section>' }],
      nav: '<li><a href="chapter.xhtml">正文</a></li><li><a href="notes.xhtml">注释</a></li>',
    });
    const decoded = await decodeEbookFile(plain.file);
    expect(decoded.chapters).toHaveLength(1);
    expect(decoded.toc).toHaveLength(1);
    expect(decoded.diagnostics.missingTocItems).toBe(0);
    const rich = await fixture({
      entries: [{ id: "c1", file: "chapter.xhtml", body: '<p>正文<a href="notes.xhtml#fn1">1</a></p>' }, { id: "notes", file: "notes.xhtml", body: '<h1>注释</h1><aside epub:type="footnote" id="fn1"><p>注释表格</p><table><tr><td>甲</td><td>乙</td></tr></table></aside>' }],
      spine: ["c1"],
    });
    const result = await decodeEbookFile(rich.file);
    expect(result.chapters).toHaveLength(2);
    expect(result.diagnostics.errors).toEqual([]);
    expect(convertWereadChapter(result.chapters[1]!, []).chapter.body.value).toContain("<table>");
  });

  it("rejects encrypted content while permitting obfuscated fonts", async () => {
    const encryption = (uri: string) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const protectedBook = await fixture({ files: { "META-INF/encryption.xml": encryption("OPS/text/ch1.xhtml") } });
    await expect(decodeEbookFile(protectedBook.file)).rejects.toThrow(/加密正文/);
    const fontOnly = await fixture({ files: { "META-INF/encryption.xml": encryption("OPS/font.otf") } });
    expect((await decodeEbookFile(fontOnly.file)).chapters).toHaveLength(1);
  });

  it("removes printed contents links to intentionally excluded copyright chapters", async () => {
    const { file, directory } = await fixture({ entries: [
      { id: "contents", file: "contents.xhtml", body: '<h1>目录</h1><p><a href="copyright.xhtml">版权信息</a></p><p><a href="chapter.xhtml">正文</a></p>' },
      { id: "copyright", file: "copyright.xhtml", body: '<h1>版权信息</h1><p>版权页内容</p>' },
      { id: "chapter", file: "chapter.xhtml", body: '<h1>正文</h1><p>可阅读正文</p>' },
    ] });
    const output = path.join(directory, "build");
    expect(await buildContentPipeline({ inputPaths: [file], outputDirectory: output })).toMatchObject({ acceptedFiles: 1, chapters: 2 });
    expect((await validatePipelineOutput(output)).errors).toEqual([]);
  });

  it("keeps colliding source anchors distinct when merging fragmented spine documents", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      id: `p${index + 1}`, file: `text/p${index + 1}.xhtml`,
      body: `<section id="section"><p>第 ${index + 1} 段</p></section>${index === 0 ? '<p><a href="p2.xhtml#section">去第二段</a></p>' : ""}`,
    }));
    const { file } = await fixture({ entries, nav: '<li><a href="text/p1.xhtml#section">第一章</a></li><li><a href="text/p13.xhtml#section">第二章</a></li>' });
    const decoded = await decodeEbookFile(file);
    expect(decoded.chapters).toHaveLength(2);
    const converted = convertWereadChapter(decoded.chapters[0]!, []);
    const $ = cheerio.load(converted.chapter.body.value);
    const ids = $("[id]").map((_index, element) => $(element).attr("id")!).get();
    expect(new Set(ids).size).toBe(ids.length);
    const target = $("a[data-anchor-id]").attr("data-anchor-id");
    expect($("[id]").filter((_index, element) => $(element).attr("id") === target).next("p").text()).toBe("第 2 段");
    expect(ids).toContain(decoded.toc[0]!.anchorId);
  });

  it("retains paragraphs, images, annotations and nested TOC through delivery and EPUB reimport", async () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=", "base64"));
    const { file, directory } = await fixture({
      entries: [{ id: "c1", file: "text/ch1.xhtml", body: '<h1>第一章</h1><section id="section"><h2>第一节</h2><p>完整中文正文。<a id="note-ref" href="#fn1">1</a></p><img src="../images/插图.png" alt="插图说明"/></section><aside epub:type="footnote" id="fn1"><p>完整脚注。</p></aside>' }, { id: "image", file: "images/插图.png", mediaType: "image/png", properties: "cover-image" }],
      nav: '<li><a href="text/ch1.xhtml">第一章</a><ol><li><a href="text/ch1.xhtml#section">第一节</a></li></ol></li>',
      files: { "OPS/images/插图.png": png },
    });
    const output = path.join(directory, "build");
    const report = await buildContentPipeline({ inputPaths: [file], outputDirectory: output });
    expect(report).toMatchObject({ acceptedFiles: 1, rejectedFiles: 0, chapters: 1, annotations: 1, diagnostics: [] });
    expect((await validatePipelineOutput(output)).errors).toEqual([]);
    const summary = report.itemsBuilt[0]!;
    const canonical = JSON.parse(gunzipSync(await readFile(path.join(output, summary.canonicalObject))).toString("utf8")) as JojoCanonicalItem;
    if (canonical.content.schema !== "jojo-content/book/1") throw new Error("Expected book content");
    expect(canonical.content.chapters[0]!.body.value).toContain("完整中文正文。");
    expect(canonical.assets.some((asset) => asset.role === "cover")).toBe(true);
    const epub = await buildEpub({ itemId: canonical.itemId, title: canonical.title, author: "测试作者", language: "zh-CN", chapters: canonical.content.chapters, toc: canonical.content.toc, annotations: canonical.annotations, assets: canonical.assets, canonicalDatasetDirectory: path.dirname(path.dirname(path.dirname(path.join(output, summary.canonicalObject)))) });
    const reimport = path.join(directory, "roundtrip.epub");
    await writeFile(reimport, epub);
    const decoded = await decodeEbookFile(reimport);
    expect(decoded.toc[0]?.children?.[0]?.title).toBe("第一节");
    expect(convertWereadChapter(decoded.chapters[0]!, []).annotations[0]?.body.value).toBe("完整脚注。");
    expect(decoded.coverUrl).toMatch(/^data:image\/png;base64,/);
    expect(convertWereadChapter(decoded.chapters[0]!, []).chapter.body.value).toContain('id="note-ref"');
    canonical.content.toc[0]!.children![0]!.anchorId = "missing-anchor";
    canonical.content.chapters[0]!.assetRefs.push("asset:missing");
    await writeFile(path.join(output, summary.canonicalObject), gzipSync(JSON.stringify(canonical)));
    const invalid = await validatePipelineOutput(output);
    expect(invalid.errors.some((error) => error.includes("TOC anchor") && error.includes("missing-anchor"))).toBe(true);
    expect(invalid.errors.some((error) => error.includes("asset:missing"))).toBe(true);
  });
});
