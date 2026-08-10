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
});
