// Audit the published FT delivery graph directly from the public JOJO CDN.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const BASE = "https://blacknews.jojokanbao.cn/";
const JOX_SALT = 0x4a4f5831;
const SOURCE_INDEX = "content/newspapers/ft/index.jox";
const TIMELINE_INDEX = "content/timeline/index.jox";
const CATALOG = "catalog.jox";

const BASELINE_25 = new Set([
  "ft:723cc2b0c04c4f3cd9448dc2", "ft:f2e659020ee83ee020c73ded", "ft:4c5c8e4cbb8491bcafb45fd9",
  "ft:0a4bd63f18163b65ee785dd5", "ft:200f80f238155d9e8d94f1c6", "ft:fe8f396d0d6c1a85278ba1f2",
  "ft:ae3420cada838f3e5173c55e", "ft:d774cc72f38a98c23ae0235f", "ft:a142c0f00ed72db4a0ea2e7e",
  "ft:464edef787feab09a41b74bb", "ft:c8357092e2c0ff35fd41c7d3", "ft:24aa931c570a57744be97fd8",
  "ft:5e1177c3b5f90d861574ce89", "ft:29f873976794028739712935", "ft:b4cf70bf80af80234cf1c6d3",
  "ft:28682a462ea7553981a832b9", "ft:b50cd295be9cec758f774cb4", "ft:1ae93876e084a39a1fe214be",
  "ft:1afe8ee2d01a9ee93cf52718", "ft:20bb7e2a497301bd8271b227", "ft:5f9ad82da77b174b42c0beaf",
  "ft:80d9836b3b6f85cb4a9ba89c", "ft:2487d09a77b9717f444c179d", "ft:a1e06a966fb401bfdbbc5058",
  "ft:38bb117e4f6267a4ad0f86db",
]);

const PRE_EXACT_EXTRA_4 = new Set([
  "ft:efd21a2c341e6ca713c3dc10", "ft:d9c5727150965ff81831904c",
  "ft:e0539dc614fb4cbc92e77412", "ft:188c7a6fb26547ff4e97c43e",
]);

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function maskByte(position, objectSeed) {
  let value = ((position >>> 0) + 0x9e3779b9) ^ objectSeed ^ JOX_SALT;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value & 0xff;
}

function decodeJox(protectedBytes, objectKey) {
  const normalized = objectKey.replaceAll("\\", "/").replace(/^\/+/, "");
  const seed = fnv1a(normalized);
  const compressed = Buffer.alloc(protectedBytes.length);
  for (let index = 0; index < protectedBytes.length; index += 1) {
    compressed[index] = protectedBytes[index] ^ maskByte(index, seed);
  }
  const clear = gunzipSync(compressed);
  return { json: JSON.parse(clear.toString("utf8")), clear };
}

let nonce = 0;
async function fetchJox(objectKey) {
  const url = new URL(objectKey, BASE);
  url.searchParams.set("audit", `${Date.now()}-${nonce += 1}`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoded = decodeJox(Buffer.from(await response.arrayBuffer()), objectKey);
      return {
        ...decoded,
        headers: {
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          cacheControl: response.headers.get("cache-control"),
          age: response.headers.get("age"),
          cfCacheStatus: response.headers.get("cf-cache-status"),
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(`${objectKey}: ${lastError?.message ?? lastError}`);
}

function resolveObject(parent, child) {
  return decodeURIComponent(new URL(child.replaceAll("\\", "/"), new URL(parent, "https://jox.invalid/")).pathname.replace(/^\/+/, ""));
}

async function parallelMap(values, limit, fn) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedObjectHash(objectKey) {
  const match = /\/([0-9a-f]{64})\.jox$/i.exec(objectKey);
  return match?.[1]?.toLowerCase() ?? null;
}

const CONSUMER_SIGNALS = [
  "complete digital access to quality ft journalism",
  "explore our full range of subscriptions",
  "discover all the plans currently available in your country",
  "digital access for organisations. includes exclusive features and content",
];
const PROFESSIONAL_SIGNALS = [
  /activate your \d+ day complimentary access to read this article/,
  /premium service available as an addition to an ft professional subscription/,
];

function classifyOffer(row, fragment) {
  const text = `${row.summary ?? ""} ${fragment?.body?.value ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
  const consumerMatched = CONSUMER_SIGNALS.filter((signal) => text.includes(signal));
  const professionalMatched = PROFESSIONAL_SIGNALS.filter((signal) => signal.test(text));
  if (consumerMatched.length >= 3) return { type: "consumer", matched: consumerMatched.length };
  if (professionalMatched.length === 2) return { type: "professional", matched: professionalMatched.length };
  return null;
}

function multiset(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function multisetDiff(left, right) {
  const a = multiset(left);
  const b = multiset(right);
  const result = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const delta = (a.get(key) ?? 0) - (b.get(key) ?? 0);
    if (delta !== 0) result.push({ key, delta });
  }
  return result.sort((x, y) => x.key.localeCompare(y.key));
}

function pointerSummary(fetched) {
  return {
    revision: fetched.json.revision ?? null,
    updatedAt: fetched.json.updatedAt ?? null,
    etag: fetched.headers.etag,
    lastModified: fetched.headers.lastModified,
    cacheControl: fetched.headers.cacheControl,
    age: fetched.headers.age,
    cfCacheStatus: fetched.headers.cfCacheStatus,
  };
}

const startedAt = new Date().toISOString();
const [catalogStart, sourceIndexStart, timelineIndexStart] = await Promise.all([
  fetchJox(CATALOG), fetchJox(SOURCE_INDEX), fetchJox(TIMELINE_INDEX),
]);

const ftCatalog = catalogStart.json.datasets?.find((dataset) => dataset.datasetId === "news-ft") ?? null;
const sourceItems = sourceIndexStart.json.items ?? [];
const manifests = await parallelMap(sourceItems, 16, async (item) => {
  const objectKey = resolveObject(SOURCE_INDEX, item.manifestObject);
  return { item, objectKey, fetched: await fetchJox(objectKey) };
});
const sourceRows = manifests.flatMap(({ fetched }) => fetched.json.metadata?.articles ?? []);

const uniqueOriginalKeys = [...new Set(sourceRows.map((row) => row.articleObject))];
const originals = new Map(await parallelMap(uniqueOriginalKeys, 20, async (objectKey) => [objectKey, await fetchJox(objectKey)]));

const translationRefs = sourceRows.flatMap((row) => Object.entries(row.translations ?? {}).map(([language, translation]) => ({ row, language, translation })));
const uniqueTranslationKeys = [...new Set(translationRefs.map(({ translation }) => translation.articleObject))];
const translations = new Map(await parallelMap(uniqueTranslationKeys, 20, async (objectKey) => [objectKey, await fetchJox(objectKey)]));

const objectErrors = [];
const offerHits = [];
for (const row of sourceRows) {
  const fetched = originals.get(row.articleObject);
  const expected = expectedObjectHash(row.articleObject);
  const actual = sha256(fetched.clear);
  if (expected === null || expected !== actual) objectErrors.push({ kind: "original-hash", id: row.id, object: row.articleObject, expected, actual });
  if (fetched.json.fragmentId !== row.id) objectErrors.push({ kind: "original-fragment-id", id: row.id, object: row.articleObject, fragmentId: fetched.json.fragmentId });
  const offer = classifyOffer(row, fetched.json);
  if (offer) {
    const translationDetails = Object.entries(row.translations ?? {}).map(([language, translation]) => {
      const translated = translations.get(translation.articleObject)?.json;
      const translatedText = `${translation.summary ?? ""} ${translated?.body?.value ?? ""}`.replace(/\s+/g, " ").trim();
      return {
        language,
        stale: translation.stale === true,
        object: translation.articleObject,
        bodyCharacters: translatedText.length,
        subscriptionTerms: [...new Set((translatedText.match(/订阅|试用|免费访问|数字访问|套餐|专业服务/g) ?? []))],
      };
    });
    offerHits.push({
      issueDate: row.issueDate,
      id: row.id,
      title: row.title,
      canonicalUrl: row.canonicalUrl ?? null,
      updatedAt: row.updatedAt ?? null,
      type: offer.type,
      matched: offer.matched,
      object: row.articleObject,
      bodyCharacters: fetched.json.body?.value?.length ?? 0,
      bodyPrefix: fetched.json.body?.value?.slice(0, 240) ?? "",
      translationDetails,
    });
  }
}

let staleTranslationRefs = 0;
for (const { row, language, translation } of translationRefs) {
  if (translation.stale === true) staleTranslationRefs += 1;
  const fetched = translations.get(translation.articleObject);
  const expected = expectedObjectHash(translation.articleObject);
  const actual = sha256(fetched.clear);
  if (expected === null || expected !== actual) objectErrors.push({ kind: "translation-hash", id: row.id, language, object: translation.articleObject, expected, actual });
  if (fetched.json.fragmentId !== row.id) objectErrors.push({ kind: "translation-fragment-id", id: row.id, language, object: translation.articleObject, fragmentId: fetched.json.fragmentId });
}

const timelineRefs = timelineIndexStart.json.dates ?? [];
const timelineDays = await parallelMap(timelineRefs, 16, async (ref) => {
  const objectKey = resolveObject(TIMELINE_INDEX, ref.object);
  return { ref, objectKey, fetched: await fetchJox(objectKey) };
});
const timelineFtRows = timelineDays.flatMap(({ fetched }) => (fetched.json.articles ?? []).filter((row) => row.source?.id === "ft"));

const sourceTuple = (row) => `${row.issueDate}|${row.id}|${row.articleObject}`;
const sourceTimelineDiff = multisetDiff(sourceRows.map(sourceTuple), timelineFtRows.map(sourceTuple));
const duplicateIds = [...multiset(sourceRows.map((row) => row.id)).entries()].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count }));

const [catalogEnd, sourceIndexEnd, timelineIndexEnd] = await Promise.all([
  fetchJox(CATALOG), fetchJox(SOURCE_INDEX), fetchJox(TIMELINE_INDEX),
]);

const hitIds = new Set(offerHits.map((hit) => hit.id));
const rowsById = new Map();
for (const row of sourceRows) rowsById.set(row.id, [...(rowsById.get(row.id) ?? []), row]);
const classifyKnownIds = (knownIds) => [...knownIds].sort().map((id) => {
  const rows = rowsById.get(id) ?? [];
  return {
    id,
    status: hitIds.has(id) ? "offer-remains" : rows.length > 0 ? "present-clean" : "removed",
    placements: rows.length,
    titles: [...new Set(rows.map((row) => row.title))],
    objects: [...new Set(rows.map((row) => row.articleObject))],
  };
});
const baselineRemaining = [...BASELINE_25].filter((id) => hitIds.has(id)).sort();
const baselineCleared = [...BASELINE_25].filter((id) => !hitIds.has(id)).sort();
const extraRemaining = [...PRE_EXACT_EXTRA_4].filter((id) => hitIds.has(id)).sort();
const extraCleared = [...PRE_EXACT_EXTRA_4].filter((id) => !hitIds.has(id)).sort();
const unexpectedRemaining = [...hitIds].filter((id) => !BASELINE_25.has(id) && !PRE_EXACT_EXTRA_4.has(id)).sort();

const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  pointers: {
    start: { catalog: pointerSummary(catalogStart), source: pointerSummary(sourceIndexStart), timeline: pointerSummary(timelineIndexStart) },
    end: { catalog: pointerSummary(catalogEnd), source: pointerSummary(sourceIndexEnd), timeline: pointerSummary(timelineIndexEnd) },
    stable: {
      catalog: catalogStart.headers.etag === catalogEnd.headers.etag && catalogStart.json.revision === catalogEnd.json.revision,
      source: sourceIndexStart.headers.etag === sourceIndexEnd.headers.etag && sourceIndexStart.json.revision === sourceIndexEnd.json.revision,
      timeline: timelineIndexStart.headers.etag === timelineIndexEnd.headers.etag && timelineIndexStart.json.updatedAt === timelineIndexEnd.json.updatedAt,
    },
  },
  catalog: {
    ftEntry: ftCatalog,
    indexObjectCorrect: ftCatalog?.indexObject === SOURCE_INDEX,
    coherentRevision: catalogStart.json.revision === sourceIndexStart.json.revision,
    coherentUpdatedAt: catalogStart.json.updatedAt === sourceIndexStart.json.updatedAt && sourceIndexStart.json.updatedAt === timelineIndexStart.json.updatedAt,
  },
  sourceGraph: {
    dates: sourceItems.length,
    placements: sourceRows.length,
    uniqueIds: new Set(sourceRows.map((row) => row.id)).size,
    uniqueOriginalObjects: uniqueOriginalKeys.length,
    duplicateIds,
    manifestGeneratedAts: [...new Set(manifests.map(({ fetched }) => fetched.json.metadata?.generatedAt))].sort(),
  },
  objects: {
    originalsFetched: originals.size,
    translationRefs: translationRefs.length,
    uniqueTranslationObjects: translations.size,
    staleTranslationRefs,
    errors: objectErrors,
  },
  timeline: {
    dates: timelineRefs.length,
    ftPlacements: timelineFtRows.length,
    sourceTimelineDiff,
  },
  offers: {
    placements: offerHits.length,
    uniqueIds: hitIds.size,
    consumer: offerHits.filter((hit) => hit.type === "consumer").length,
    professional: offerHits.filter((hit) => hit.type === "professional").length,
    withTranslations: offerHits.filter((hit) => hit.translationDetails.length > 0).length,
    translationRefs: offerHits.reduce((sum, hit) => sum + hit.translationDetails.length, 0),
    translatedWithSubscriptionTerms: offerHits.filter((hit) => hit.translationDetails.some((translation) => translation.subscriptionTerms.length > 0)).length,
    baseline25: { remaining: baselineRemaining, cleared: baselineCleared, details: classifyKnownIds(BASELINE_25) },
    preExactExtra4: { remaining: extraRemaining, cleared: extraCleared, details: classifyKnownIds(PRE_EXACT_EXTRA_4) },
    unexpectedRemaining,
    hits: offerHits.sort((a, b) => `${b.issueDate}|${b.id}`.localeCompare(`${a.issueDate}|${a.id}`)),
  },
};

console.log(JSON.stringify(report, null, 2));
