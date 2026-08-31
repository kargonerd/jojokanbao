import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArticleBodyAssessmentReport } from "../content/body.js";
import type { CapturedHtmlPage } from "./http.js";

export interface RawPageOwner {
  articleId: string;
  sourceId: string;
  manifestPath: string;
}

export async function writeRawPage(
  workspace: string,
  article: RawPageOwner,
  page: CapturedHtmlPage,
  error?: string,
  bodyAssessment?: ArticleBodyAssessmentReport,
): Promise<string> {
  const runRoot = path.dirname(article.manifestPath);
  const pageKey = createHash("sha256").update(article.articleId).digest("hex").slice(0, 32);
  const pageRoot = path.join(runRoot, "pages", pageKey);
  await mkdir(pageRoot, { recursive: true });
  if (page.originalHtml) await writeFile(path.join(pageRoot, "original.html.gz"), gzipSync(page.originalHtml, { level: 9 }));
  if (page.renderedHtml) await writeFile(path.join(pageRoot, "rendered.html.gz"), gzipSync(page.renderedHtml, { level: 9 }));
  const metadataPath = path.join(pageRoot, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify({
    formatVersion: "jojo-raw-page/1",
    articleId: article.articleId,
    sourceId: article.sourceId,
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    method: page.method,
    status: page.status ?? null,
    capturedAt: page.capturedAt,
    originalHtml: page.originalHtml ? "original.html.gz" : null,
    renderedHtml: page.renderedHtml ? "rendered.html.gz" : null,
    error: page.error ?? error ?? null,
    ...(bodyAssessment ? { bodyAssessment } : {}),
  }, null, 2)}\n`);
  return path.relative(workspace, metadataPath).replaceAll(path.sep, "/");
}
