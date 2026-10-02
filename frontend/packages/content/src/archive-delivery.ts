import { ARCHIVE_PUBLICATION_BY_ID, type ArchivePublicationName } from "./archive";
import { JoxClient, resolveJoxObject } from "./jox";
import { asJojoCatalog, asJojoDatasetIndex, asJojoItemManifest } from "./validation";
import type { JojoAdaptiveCalendar, JojoDatasetIndex } from "./types";

export interface ArchivePdfSource {
  url: string;
  objectKey: string;
}

async function fetchArchiveDatasetIndex(
  client: JoxClient,
  publication: ArchivePublicationName,
  signal?: AbortSignal,
): Promise<{ entry: { indexObject: string }; index: JojoDatasetIndex & { items: NonNullable<JojoDatasetIndex["items"]> } }> {
  const catalog = asJojoCatalog(await client.fetchJson("catalog.jox", signal));
  const entry = catalog.datasets.find((row) => row.datasetId === publication && row.publicationStatus !== "draft");
  if (!entry) throw new Error("该报刊尚未发布");
  const index = asJojoDatasetIndex(await client.fetchJson(entry.indexObject, signal));
  if (index.datasetId !== publication || index.publicationStatus === "draft") throw new Error("报刊索引不匹配");
  return { entry, index };
}

/** Resolve the published asset; filenames and directories belong to the manifest. */
export async function loadArchivePdf(
  client: JoxClient,
  publication: ArchivePublicationName,
  issueId: string,
  signal?: AbortSignal,
): Promise<ArchivePdfSource> {
  const newspaper = ARCHIVE_PUBLICATION_BY_ID[publication].type === "newspaper";
  const day = issueId.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  if (newspaper ? !/^\d{8}$/.test(issueId) || !Number.isFinite(Date.parse(day))
    || new Date(day).toISOString().slice(0, 10) !== day : !/^\d{6}$/.test(issueId)) {
    throw new Error("报刊日期或期号无效");
  }
  const { entry, index } = await fetchArchiveDatasetIndex(client, publication, signal);
  const itemKey = newspaper ? day : issueId;
  const item = index.items.find((row) => row.itemKey === itemKey || row.itemId === `${publication}:${itemKey}`);
  const path = item?.manifestObject ?? (newspaper ? index.itemPath
    ?.replaceAll("{YYYY-MM-DD}", day).replaceAll("{YYYY}", day.slice(0, 4)).replaceAll("{MM}", day.slice(5, 7)) : undefined);
  if (!path || /[{}]/.test(path) || item?.publicationStatus === "draft") throw new Error("该期报刊尚未发布");
  const manifestObject = resolveJoxObject(entry.indexObject, path);
  const manifest = asJojoItemManifest(await client.fetchJson(manifestObject, signal));
  if (manifest.datasetId !== publication || manifest.itemId !== `${publication}:${itemKey}`
    || manifest.publicationStatus === "draft") throw new Error("报刊内容不匹配");
  const pdfs = manifest.assets.filter((asset) => asset.type === "pdf" && asset.mediaType === "application/pdf");
  const pdf = pdfs.find((asset) => asset.role === "issue-pdf") ?? (pdfs.length === 1 ? pdfs[0] : undefined);
  if (manifest.availability?.pdf === "missing" || !pdf) throw new Error("该期报刊暂无 PDF");
  const objectKey = resolveJoxObject(manifestObject, pdf.object);
  const url = client.url(objectKey);
  url.searchParams.set("v", pdf.sha256);
  return { url: url.href, objectKey };
}

/**
 * Published issue keys of a magazine Dataset (e.g. "hq" → "195801"…"198812"),
 * in ascending order. Magazines list every issue in the dataset index, unlike
 * itemPath-driven newspapers whose calendars are derived per date, so this is
 * what pickers should offer instead of a hardcoded issue table.
 */
export async function loadArchiveIssueKeys(
  client: JoxClient,
  publication: ArchivePublicationName,
  signal?: AbortSignal,
): Promise<string[]> {
  if (ARCHIVE_PUBLICATION_BY_ID[publication].type !== "magazine") {
    throw new Error("该报刊不提供期数索引");
  }
  const { index } = await fetchArchiveDatasetIndex(client, publication, signal);
  return index.items
    .filter((item) => item.publicationStatus !== "draft")
    .map((item) => item.itemKey)
    .sort();
}

/**
 * The PDF availability calendar of a newspaper Dataset ("rmrb"/"ckxx").
 * Newspapers derive their items from itemPath instead of enumerating dates, so
 * the dataset index publishes a jojo-periodical-availability adaptive calendar
 * describing exactly which days have PDFs; date pickers should gate on it.
 */
export async function loadArchivePdfCalendar(
  client: JoxClient,
  publication: ArchivePublicationName,
  signal?: AbortSignal,
): Promise<JojoAdaptiveCalendar | null> {
  if (ARCHIVE_PUBLICATION_BY_ID[publication].type !== "newspaper") {
    throw new Error("该报刊不提供日期日历");
  }
  const { index } = await fetchArchiveDatasetIndex(client, publication, signal);
  const periodical = index.availability && "formatVersion" in index.availability ? index.availability : null;
  const pdf = periodical?.pdf ?? null;
  return pdf && pdf.format === "adaptive-calendar/1" ? pdf : null;
}
