import { ARCHIVE_PUBLICATION_BY_ID, type ArchivePublicationName } from "./archive";
import { JoxClient, resolveJoxObject } from "./jox";
import { asJojoCatalog, asJojoDatasetIndex, asJojoItemManifest } from "./validation";

export interface ArchivePdfSource {
  url: string;
  objectKey: string;
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
  const catalog = asJojoCatalog(await client.fetchJson("catalog.jox", signal));
  const entry = catalog.datasets.find((row) => row.datasetId === publication && row.publicationStatus !== "draft");
  if (!entry) throw new Error("该报刊尚未发布");
  const index = asJojoDatasetIndex(await client.fetchJson(entry.indexObject, signal));
  if (index.datasetId !== publication || index.publicationStatus === "draft") throw new Error("报刊索引不匹配");
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
