import { createRagTools } from "./rag-tools";

const query = process.argv.slice(2).join(" ").trim() || "童年时代";
const searchUrl = process.env.JOJO_CONTENT_SEARCH_URL?.trim();
const contentCdnBase = process.env.JOJO_CONTENT_CDN_BASE?.trim();
if (!searchUrl || !contentCdnBase) {
  throw new Error("JOJO_CONTENT_SEARCH_URL and JOJO_CONTENT_CDN_BASE are required");
}

const datasetIds = process.env.JOJO_CONTENT_DATASET_ID?.trim()
  ? [process.env.JOJO_CONTENT_DATASET_ID.trim()]
  : undefined;
const itemIds = process.env.JOJO_CONTENT_ITEM_ID?.trim()
  ? [process.env.JOJO_CONTENT_ITEM_ID.trim()]
  : undefined;
const tools = createRagTools({
  searchUrl,
  contentCdnBase,
  scope: { datasetIds, itemIds },
});
const search = tools.find((tool) => tool.name === "search_content")!;
const read = tools.find((tool) => tool.name === "read_fragment")!;
const inspect = tools.find((tool) => tool.name === "inspect_item")!;
const toc = tools.find((tool) => tool.name === "list_item_toc")!;
const scan = tools.find((tool) => tool.name === "scan_full_item")!;
const signal = new AbortController().signal;

const searchResult = await search.execute(
  "content-smoke-search",
  { query, size: 5 },
  signal,
) as { details?: { total?: number; hits?: Array<Record<string, unknown>> } };
const hits = searchResult.details?.hits ?? [];
if (!hits.length) throw new Error(`No content search hits for ${JSON.stringify(query)}`);
const first = hits[0]!;

const readResult = await read.execute(
  "content-smoke-read",
  { fragmentObject: String(first.fragmentObject), maxChars: 2_000 },
  signal,
) as { details?: Record<string, unknown> };
const inspectResult = await inspect.execute(
  "content-smoke-inspect",
  { manifestObject: String(first.manifestObject) },
  signal,
) as { details?: Record<string, unknown> };
const tocResult = await toc.execute(
  "content-smoke-toc",
  { manifestObject: String(first.manifestObject), offset: 0, limit: 10 },
  signal,
) as { details?: Record<string, unknown> };

let scanDetails: Record<string, unknown> | undefined;
if (process.env.JOJO_CONTENT_SMOKE_FULL_SCAN?.toLowerCase() === "true") {
  const scanResult = await scan.execute(
    "content-smoke-scan",
    {
      manifestObject: String(first.manifestObject),
      intent: "端到端验证 Agent 可按需扫描整本 Item",
      terms: [query],
      maxEvidenceChapters: 3,
    },
    signal,
  ) as { details?: Record<string, unknown> };
  scanDetails = scanResult.details;
}

process.stdout.write(`${JSON.stringify({
  query,
  total: searchResult.details?.total,
  hitCount: hits.length,
  firstHit: {
    datasetId: first.datasetId,
    itemId: first.itemId,
    title: first.targetTitle,
    fragmentObject: first.fragmentObject,
  },
  read: readResult.details,
  inspect: inspectResult.details,
  toc: tocResult.details,
  ...(scanDetails ? { scan: scanDetails } : {}),
}, null, 2)}\n`);
