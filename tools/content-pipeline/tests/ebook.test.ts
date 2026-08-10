import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { decodeEbookFile, palmDocDecompress } from "../src";

describe("Kindle PalmDOC decoding", () => {
  it("decodes literals, space shortcuts, and back references", () => {
    const encoded = Uint8Array.from([
      3, 0x61, 0x62, 0x63,
      0xc4,
      0x80, 0x2a,
    ]);
    expect(Buffer.from(palmDocDecompress(encoded)).toString("utf8")).toBe("abc Dabc D");
  });

  it("imports an EPUB spine, navigation, and embedded image", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jojo-epub-test-"));
    try {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip");
      zip.file("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
      zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>测试书</dc:title><dc:creator>作者</dc:creator><dc:identifier>book-id</dc:identifier><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="img" href="image.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>`);
      zip.file("OEBPS/nav.xhtml", `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>`);
      zip.file("OEBPS/chapter.xhtml", `<html><body><h1>第一章</h1><p>正文</p><img src="image.png"/></body></html>`);
      zip.file("OEBPS/image.png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const file = path.join(directory, "book.epub");
      await writeFile(file, await zip.generateAsync({ type: "uint8array" }));

      const decoded = await decodeEbookFile(file);
      expect(decoded).toMatchObject({ sourceKind: "epub", title: "测试书", author: "作者" });
      expect(decoded.chapters).toHaveLength(1);
      expect(decoded.chapters[0]!.content).toContain("data:image/png;base64,");
      expect(decoded.toc[0]).toMatchObject({ title: "第一章", targetId: decoded.chapters[0]!.id });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces a highly fragmented EPUB spine by navigation boundaries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jojo-fragmented-epub-test-"));
    try {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip");
      zip.file("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
      const manifest = Array.from({ length: 30 }, (_value, index) => (
        `<item id="p${index + 1}" href="p${index + 1}.xhtml" media-type="application/xhtml+xml"/>`
      )).join("");
      const spine = Array.from({ length: 30 }, (_value, index) => `<itemref idref="p${index + 1}"/>`).join("");
      zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>碎片书</dc:title><dc:creator>作者</dc:creator><dc:identifier>fragmented-id</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>`);
      zip.file("OEBPS/nav.xhtml", `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="p1.xhtml">第一章</a></li><li><a href="p11.xhtml">第二章</a></li><li><a href="p21.xhtml">第三章</a></li></ol></nav></body></html>`);
      for (let index = 1; index <= 30; index += 1) {
        zip.file(`OEBPS/p${index}.xhtml`, `<html><body><p>第 ${index} 个正文片段</p></body></html>`);
      }
      const file = path.join(directory, "碎片书 (作者) (z-library.sk).epub");
      await writeFile(file, await zip.generateAsync({ type: "uint8array" }));

      const decoded = await decodeEbookFile(file);
      expect(decoded.chapters).toHaveLength(3);
      expect(decoded.chapters[0]).toMatchObject({ title: "第一章", sourceFiles: expect.arrayContaining(["OEBPS/p1.xhtml", "OEBPS/p10.xhtml"]) });
      expect(decoded.chapters[1]!.sourceFiles).toContain("OEBPS/p20.xhtml");
      expect(decoded.toc[1]).toMatchObject({ title: "第二章", targetId: decoded.chapters[1]!.id });
      expect(decoded.toc[1]!.anchorId).toMatch(/^epub-source-/);
      expect(decoded.diagnostics).toMatchObject({ sourceChapterRecords: 30, presentChapterRecords: 30, chapterCoverage: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses useful filename metadata when EPUB package metadata is suspicious", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jojo-epub-metadata-test-"));
    try {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip");
      zip.file("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`);
      zip.file("content.opf", `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>十年非梦</dc:title><dc:creator>iPhone</dc:creator><dc:identifier>metadata-id</dc:identifier></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
      zip.file("chapter.xhtml", "<html><body><p>正文</p></body></html>");
      const file = path.join(directory, "十年非梦——黄金海回忆录(修订版) (黄金海) (z-library.sk, 1lib.sk).epub");
      await writeFile(file, await zip.generateAsync({ type: "uint8array" }));

      const decoded = await decodeEbookFile(file);
      expect(decoded).toMatchObject({ title: "十年非梦——黄金海回忆录(修订版)", author: "黄金海" });
      expect(decoded.sourceDetails).toMatchObject({ packageTitle: "十年非梦", packageAuthor: "iPhone" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
