import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  gunzipJoxJson,
  resolveJoxObject,
  type JojoBookSearchIndex,
  type JojoCatalog,
  type JojoDatasetIndex,
  type JojoItemManifest,
} from "@jojo/content";
import { buildContentPipeline } from "../src";
import { validatePipelineOutput } from "../src/validate-output";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("approved B2 layout", () => {
  it("keeps Raw flat, Canonical minimal, and Delivery categorized", async () => {
    const sourceDirectory = await temporaryDirectory("jojo-layout-source-");
    const outputParent = await temporaryDirectory("jojo-layout-output-");
    const output = path.join(outputParent, "build");
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
    zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>测试书</dc:title><dc:creator>作者</dc:creator><dc:identifier>book-id</dc:identifier><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
    zip.file("OEBPS/nav.xhtml", `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>`);
    zip.file("OEBPS/chapter.xhtml", `<html><body><h1>第一章</h1><p>正文</p></body></html>`);
    const source = path.join(sourceDirectory, "undefined.epub");
    await writeFile(source, await zip.generateAsync({ type: "uint8array" }));

    const report = await buildContentPipeline({
      inputPaths: [source],
      outputDirectory: output,
      fetchAssets: false,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      publicationStatus: "published",
      access: "authenticated",
    });

    expect(report.itemsBuilt[0]).toMatchObject({
      datasetId: "ce-shi-shu",
      itemId: "ce-shi-shu:full-book",
      canonicalObject: "canonical/books/ce-shi-shu/items/full-book/item.json.gz",
      manifestObject: "content/books/ce-shi-shu/items/full-book/manifest.jox",
    });
    expect(await readdir(path.join(output, "raw", "epub"))).toEqual(["测试书--book-id.epub"]);
    expect(JSON.parse(await readFile(path.join(output, "canonical", "books", "ce-shi-shu", "dataset.json"), "utf8"))).toMatchObject({
      formatVersion: "jojo-dataset/1",
      datasetId: "ce-shi-shu",
      itemPath: "items/{itemKey}/item.json.gz",
    });
    expect(await exists(path.join(output, "canonical", "catalog.json"))).toBe(false);
    expect(await exists(path.join(output, "canonical", "books", "ce-shi-shu", "search"))).toBe(false);
    expect(await exists(path.join(output, "raw", "catalog.json"))).toBe(false);
    expect(await exists(path.join(output, "raw", "epub", "index.json"))).toBe(false);
    expect(await exists(path.join(output, "delivery", "content", "books", "ce-shi-shu", "index.jox"))).toBe(true);
    const catalog = await gunzipJoxJson<JojoCatalog>(
      new Uint8Array(await readFile(path.join(output, "delivery", "catalog.jox"))),
      "catalog.jox",
    );
    expect(catalog.datasets[0]).toMatchObject({
      datasetId: "ce-shi-shu",
      aiEnabled: true,
    });
    const datasetIndexObject = catalog.datasets[0]!.indexObject;
    const datasetIndex = await gunzipJoxJson<JojoDatasetIndex>(
      new Uint8Array(await readFile(path.join(output, "delivery", ...datasetIndexObject.split("/")))),
      datasetIndexObject,
    );
    expect(datasetIndex.aiEnabled).toBe(true);
    const manifestObject = report.itemsBuilt[0]!.manifestObject;
    const manifest = await gunzipJoxJson<JojoItemManifest>(
      new Uint8Array(await readFile(path.join(output, "delivery", ...manifestObject.split("/")))),
      manifestObject,
    );
    expect(manifest.search).toMatchObject({
      format: "text",
      profile: "jojo-book-search/1",
      object: "search/text.jox",
    });
    expect(manifest).toMatchObject({ publicationStatus: "published", access: "authenticated" });
    const searchObject = resolveJoxObject(manifestObject, manifest.search!.object);
    const search = await gunzipJoxJson<JojoBookSearchIndex>(
      new Uint8Array(await readFile(path.join(output, "delivery", ...searchObject.split("/")))),
      searchObject,
    );
    expect(search).toMatchObject({
      formatVersion: "jojo-book-search/1",
      itemId: "ce-shi-shu:full-book",
    });
    expect(search.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: expect.any(String), text: "正文" }),
    ]));
    expect((await validatePipelineOutput(output)).errors).toEqual([]);
  });
});
