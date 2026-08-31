import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  JojoCatalog,
  JojoFragment,
  TimesSourceIndex,
  TimesTimelineDay,
  TimesTimelineIndex,
} from "@jojo/content";
import { describe, expect, it } from "vitest";
import { buildNewsDelivery, readJoxJson } from "../src/delivery-writer.js";
import { sha256 } from "../src/identity.js";
import { runProcess } from "../src/process-cli.js";
import type { CanonicalArticle, CanonicalDateIndex } from "../src/process/canonical-writer.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "../src/types.js";

async function writeRawRun(
  output: string,
  source: SourceConfig,
  runId: string,
  candidate: Candidate,
): Promise<string> {
  const manifestObject = `raw/${source.id}/runs/2026/08/30/${runId}/manifest.json`;
  const manifestPath = path.join(output, ...manifestObject.split("/"));
  const manifest: SourceCaptureManifest = {
    formatVersion: "jojo-times-raw-source-run/2",
    runId,
    sourceId: source.id,
    sourceName: source.name,
    publicationTimeZone: source.publicationTimeZone,
    startedAt: "2026-08-30T00:00:00Z",
    completedAt: "2026-08-30T00:01:00Z",
    discovery: source.discovery,
    candidateCount: 1,
    fullCount: 1,
    summaryCount: 0,
    metadataCount: 0,
    networkExchangeCount: 0,
    objects: [],
    captureStatus: "pages-complete",
    healthStatus: "healthy",
    complete: true,
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  await writeFile(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"), gzipSync(`${JSON.stringify(candidate)}\n`));
  const runManifestPath = path.join(output, "raw", "runs", `${runId}.json`);
  await mkdir(path.dirname(runManifestPath), { recursive: true });
  await writeFile(runManifestPath, `${JSON.stringify({
    runId,
    sources: [{ sourceId: source.id, status: "ok", output: { manifest: manifestObject } }],
  })}\n`, "utf8");
  return runManifestPath;
}

async function gzipJson<T>(root: string, objectName: string): Promise<T> {
  return JSON.parse(gunzipSync(await readFile(path.join(root, ...objectName.split("/")))).toString("utf8")) as T;
}

async function joxJson<T>(root: string, objectName: string): Promise<T> {
  return readJoxJson<T>(new Uint8Array(await readFile(path.join(root, ...objectName.split("/")))), objectName);
}

describe("Times Process and Delivery integration", () => {
  it("reuses a richer The Paper article when a full discovery candidate is marked unchanged", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-process-unchanged-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-delivery-unchanged-"));
    const source = JSON.parse(await readFile(path.resolve("src/sources/thepaper/source.json"), "utf8")) as SourceConfig;
    const articleId = "thepaper:33971197";
    const canonicalUrl = "https://www.thepaper.cn/newsDetail_forward_33971197";
    const publishedAt = "2026-08-30T02:00:00Z";
    const issueDate = publishedAt.slice(0, 10);
    const paragraphs = [
      "第一段正文记录了完整报道和现场细节，并用于确认图片仍然位于原有正文位置。".repeat(2),
      "第二段正文补充相关部门回应、时间和背景，确保发现正文达到完整内容门槛。".repeat(2),
    ];
    const discoveryBody = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("");
    const rawPageObject = "raw/thepaper/runs/2026/08/30/run-rich/pages/33971197/metadata.json";
    const rawPageRoot = path.join(output, path.dirname(rawPageObject));
    const assetBytes = Buffer.from("prior-thepaper-image-bytes");
    const assetObject = `raw/thepaper/assets/${sha256(assetBytes)}.jpg`;
    const asset = {
      id: "asset:thepaper-photo",
      type: "image" as const,
      role: "content" as const,
      sourceUrl: "https://imgpai.thepaper.cn/33971197.jpg",
      rawObject: assetObject,
      mediaType: "image/jpeg",
      size: assetBytes.length,
      sha256: sha256(assetBytes),
      caption: "此前抓取的现场图片",
      afterBlock: 1,
    };
    const renderedHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { detailData: { contentDetail: { content: discoveryBody } } } },
    })}</script>`;
    await mkdir(rawPageRoot, { recursive: true });
    await writeFile(path.join(rawPageRoot, "rendered.html.gz"), gzipSync(renderedHtml));
    await writeFile(path.join(rawPageRoot, "metadata.json"), JSON.stringify({
      formatVersion: "jojo-raw-page/1",
      renderedHtml: "rendered.html.gz",
    }));
    await mkdir(path.dirname(path.join(output, ...assetObject.split("/"))), { recursive: true });
    await writeFile(path.join(output, ...assetObject.split("/")), assetBytes);

    const richCandidate: Candidate = {
      articleId,
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      title: "保留图文内容的报道",
      rawPageObject,
      captureStatus: "captured",
      captureMethod: "direct",
      assets: [asset],
      contentStatus: "full",
      publishedAt,
      authors: ["澎湃新闻记者"],
      publisherCategories: ["时事"],
      publisherSections: [{ id: "current-affairs", name: "时事" }],
    };
    const firstRunManifest = await writeRawRun(output, source, "run-rich", richCandidate);
    const processArgs = (runManifestPath: string, rawRevision: string) => new Map([
      ["config", path.resolve("sources.v2.json")],
      ["output", output],
      ["run-manifest", runManifestPath],
      ["raw-revision", rawRevision],
      ["translate", "false"],
    ]);
    const first = await runProcess(processArgs(firstRunManifest, "rich-revision"));
    expect(first.sources[0]?.articles).toHaveLength(1);
    const richRef = first.sources[0]!.articles[0]!;
    const richCanonical = await gzipJson<CanonicalArticle>(output, richRef.object);
    expect(richCanonical.body.value).toContain('<figure data-asset-id="asset:thepaper-photo">');
    expect(richCanonical.assets).toEqual([expect.objectContaining({ id: asset.id, rawObject: assetObject })]);
    expect(richCanonical.provenance.rawPage).toBe(rawPageObject);

    const firstDelivery = await buildNewsDelivery({
      workspaceRoot: output,
      deliveryRoot,
      generatedAt: "2026-08-30T02:05:00Z",
      sources: [source],
      process: first,
    });
    expect(firstDelivery.articles).toBe(1);
    const timelineIndexObject = "content/timeline/index.jox";
    const dayObject = `content/timeline/dates/${issueDate.slice(0, 4)}/${issueDate.slice(5, 7)}/${issueDate}.jox`;
    const sourceIndexObject = `content/newspapers/${source.id}/index.jox`;
    const firstTimeline = await joxJson<TimesTimelineIndex>(deliveryRoot, timelineIndexObject);
    const firstDay = await joxJson<TimesTimelineDay>(deliveryRoot, dayObject);
    const firstSourceIndex = await joxJson<TimesSourceIndex>(deliveryRoot, sourceIndexObject);
    const firstCatalog = await joxJson<JojoCatalog>(deliveryRoot, "catalog.jox");
    const deliveredBefore = firstDay.articles.find((article) => article.id === articleId)!;
    const fragmentBefore = await joxJson<JojoFragment>(deliveryRoot, deliveredBefore.articleObject);
    expect(fragmentBefore.body.value).toContain('<figure data-asset-id="asset:thepaper-photo">');
    expect(fragmentBefore.assetRefs).toEqual([asset.id]);

    const unchangedCandidate: Candidate = {
      articleId,
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      title: richCandidate.title,
      discoveryBody,
      captureStatus: "unchanged",
      assets: [],
      contentStatus: "full",
      publishedAt,
      authors: richCandidate.authors,
      publisherCategories: richCandidate.publisherCategories,
      publisherSections: [{ id: "current-affairs", name: "时事" }],
    };
    const unchangedRunManifest = await writeRawRun(output, source, "run-unchanged", unchangedCandidate);
    const second = await runProcess(processArgs(unchangedRunManifest, "unchanged-revision"));
    expect(second.sources[0]).toMatchObject({
      articles: [],
      unchangedWithoutRefresh: 1,
      unchangedArticles: [expect.objectContaining({ articleId, captureStatus: "unchanged" })],
    });
    const canonicalDateObject = `canonical/${source.id}/dates/${issueDate.slice(0, 4)}/${issueDate.slice(5, 7)}/${issueDate}.json.gz`;
    const canonicalDate = await gzipJson<CanonicalDateIndex>(output, canonicalDateObject);
    expect(canonicalDate.articles.find((article) => article.articleId === articleId)).toEqual(richRef);

    const secondDelivery = await buildNewsDelivery({
      workspaceRoot: output,
      deliveryRoot,
      generatedAt: "2026-08-30T02:15:00Z",
      sources: [source],
      process: second,
      previousTimelineIndex: firstTimeline,
      previousTimelineDays: new Map([[issueDate, firstDay]]),
      previousSourceIndexes: new Map([[source.id, firstSourceIndex]]),
      previousCatalog: firstCatalog,
    });
    expect(secondDelivery.articles).toBe(0);
    const retainedDay = await joxJson<TimesTimelineDay>(deliveryRoot, dayObject);
    const deliveredAfter = retainedDay.articles.find((article) => article.id === articleId)!;
    expect(deliveredAfter.articleObject).toBe(deliveredBefore.articleObject);
    expect(deliveredAfter.assets).toEqual(deliveredBefore.assets);
    const retainedFragment = await joxJson<JojoFragment>(deliveryRoot, deliveredAfter.articleObject);
    expect(retainedFragment.body.value).toContain('<figure data-asset-id="asset:thepaper-photo">');
    expect(retainedFragment.assetRefs).toEqual([asset.id]);
  });
});
