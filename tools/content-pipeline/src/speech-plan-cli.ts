/** Pure planning: no TTS calls or cloud writes. Uses the exact reader splitter. */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { load } from "cheerio";
import { JoxClient, asJojoCatalog, resolveJoxObject, speechSegments, SPEECH_EXCLUDED_ELEMENTS, SPEECH_BLOCK_ELEMENTS,
  type JojoCanonicalItem, type JojoDatasetIndex, type JojoItemManifest, type JojoFragment } from "@jojo/content";

export function speechHtmlBlocks(html: string): string[] {
  const $ = load(html);
  $(SPEECH_EXCLUDED_ELEMENTS).remove();
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const blocks = $(SPEECH_BLOCK_ELEMENTS).toArray()
    .filter((element) => !$(element).find(SPEECH_BLOCK_ELEMENTS).length)
    .map((element) => normalize($(element).text())).filter(Boolean);
  return blocks.length ? blocks : [normalize($("body").text())].filter(Boolean);
}

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else if (entry.name === "item.json.gz") result.push(filename);
  }
  return result.sort();
}

export async function buildSpeechPlan(root: string, dataset?: string) {
  const books = [];
  for (const filename of await files(root)) {
    const item = JSON.parse(gunzipSync(await readFile(filename)).toString("utf8")) as JojoCanonicalItem;
    if (item.formatVersion !== "jojo-item/1" || item.content.schema !== "jojo-content/book/1"
        || (dataset && item.datasetId !== dataset) || item.publicationStatus === "draft") continue;
    books.push({ datasetId: item.datasetId, itemKey: path.basename(path.dirname(filename)), title: item.title,
      chapters: [...item.content.chapters].sort((a, b) => a.order - b.order).map((chapter) => ({
        id: chapter.id, title: chapter.title,
        segments: speechSegments(chapter.title, chapter.body.value, chapter.body.format, 500, speechHtmlBlocks),
      })).filter((chapter) => chapter.segments.length),
    });
  }
  return { formatVersion: "jojo-speech-plan/1", books };
}

export async function buildCdnSpeechPlan(cdn: string, dataset: string, indexObject = `content/books/${dataset}/index.jox`) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(dataset)) throw new Error("Invalid dataset ID");
  const client = new JoxClient(cdn);
  const index = await client.fetchJson<JojoDatasetIndex>(indexObject);
  if (index.publicationStatus === "draft") throw new Error("Dataset is not published");
  const books = [];
  for (const item of index.items ?? []) {
    if (item.publicationStatus === "draft") continue;
    const manifestObject = resolveJoxObject(indexObject, item.manifestObject);
    const manifest = await client.fetchJson<JojoItemManifest>(manifestObject);
    if (manifest.publicationStatus === "draft") continue;
    const chapters = [];
    for (const chapter of [...manifest.content.chapters ?? []].sort((a, b) => a.order - b.order)) {
      const fragment = await client.fetchJson<JojoFragment>(resolveJoxObject(manifestObject, chapter.object));
      chapters.push({ id: chapter.id, title: fragment.title,
        segments: speechSegments(fragment.title, fragment.body.value, fragment.body.format, 500, speechHtmlBlocks) });
    }
    books.push({ datasetId: dataset, itemKey: item.itemKey, title: manifest.title, chapters });
  }
  return { formatVersion: "jojo-speech-plan/1", books };
}

export async function buildCdnLibrarySpeechPlan(cdn: string) {
  const client = new JoxClient(cdn);
  const catalog = asJojoCatalog(await client.fetchJson("catalog.jox", undefined, "no-store"));
  const datasets = catalog.datasets.filter((entry) =>
    (entry.type === "book" || entry.type === "book-series") && entry.publicationStatus !== "draft");
  const books = [];
  for (const [index, dataset] of datasets.entries()) {
    const plan = await buildCdnSpeechPlan(cdn, dataset.datasetId, dataset.indexObject);
    books.push(...plan.books);
    console.log(`Planned dataset ${index + 1}/${datasets.length}: ${dataset.datasetId}`);
  }
  return { formatVersion: "jojo-speech-plan/1", books };
}

if (process.argv[1]?.endsWith("speech-plan-cli.ts")) {
  const { values } = parseArgs({ options: { canonical: { type: "string" }, output: { type: "string" }, dataset: { type: "string" }, cdn: { type: "string" }, "all-books": { type: "boolean" } } });
  if (!values.output || (!values.canonical && !(values.cdn && (values.dataset || values["all-books"])))) throw new Error("Use --canonical <canonical/books> or --cdn <base> with --dataset <id> / --all-books, and --output <plan.json>");
  const plan = values.canonical ? await buildSpeechPlan(path.resolve(values.canonical), values.dataset)
    : values["all-books"] ? await buildCdnLibrarySpeechPlan(values.cdn!) : await buildCdnSpeechPlan(values.cdn!, values.dataset!);
  if (!plan.books.length) throw new Error("No published books matched the input");
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(values.output, JSON.stringify(plan));
  const chapters = plan.books.flatMap((book) => book.chapters);
  const segments = chapters.flatMap((chapter) => chapter.segments);
  console.log(JSON.stringify({ books: plan.books.length, chapters: chapters.length, segments: segments.length,
    characters: segments.reduce((sum, text) => sum + text.length, 0), output: path.resolve(values.output) }));
}
