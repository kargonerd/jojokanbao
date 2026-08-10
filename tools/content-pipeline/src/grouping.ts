import { createHash } from "node:crypto";
import type { JojoCanonicalChapter, JojoTocNode } from "@jojo/content";
import { pinyin } from "pinyin-pro";

const CHINESE_DIGITS: Record<string, number> = {
  "〇": 0,
  "零": 0,
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};

export function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.includes("百")) {
    const [hundreds, tail = ""] = value.split("百", 2);
    const high = CHINESE_DIGITS[hundreds || "一"];
    const low = tail ? chineseNumber(tail.replace(/^零/, "")) : 0;
    return high === undefined || low === undefined ? undefined : high * 100 + low;
  }
  if (value.includes("十")) {
    const [tens, units] = value.split("十", 2);
    const high = tens ? CHINESE_DIGITS[tens] : 1;
    const low = units ? CHINESE_DIGITS[units] : 0;
    return high === undefined || low === undefined ? undefined : high * 10 + low;
  }
  if ([...value].every((character) => character in CHINESE_DIGITS)) {
    return Number([...value].map((character) => CHINESE_DIGITS[character]).join(""));
  }
  return undefined;
}

const NUMBER = "[〇零一二两三四五六七八九十百\\d]+";
const SEPARATE_VOLUME = new RegExp(`^(.*?)[（(]\\s*第(${NUMBER})卷\\s*[）)](?:\\s*(.*))?$`);
const ALL_VOLUMES = new RegExp(`[（(]?\\s*全(${NUMBER})卷\\s*[）)]?`);
const VOLUME_RANGE = new RegExp(`[（(]?\\s*(?:1|一)\\s*[-—–至到]\\s*(${NUMBER})卷\\s*[）)]?`);
const VOLUME_REFERENCE = new RegExp(`(?:^|[（(\\s　])第(${NUMBER})卷(?:$|[）)\\s　:：])`);
const VOLUME_HEADING = new RegExp(`^(?:.+?)?[（(]?第(${NUMBER})卷[）)]?$`);

export interface BookGrouping {
  datasetTitle: string;
  datasetId: string;
  datasetType: "book" | "book-series";
  sourceVolumeNumber?: number;
  declaredTotalVolumes?: number;
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function datasetIdForTitle(title: string): string {
  const normalized = normalizedTitle(title);
  const slug = pinyin(normalized, {
    toneType: "none",
    nonZh: "consecutive",
    separator: "-",
  }).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) return `book-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
  if (slug.length <= 80) return slug;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${slug.slice(0, 71).replace(/-+$/g, "")}-${suffix}`;
}

export function groupBookTitle(title: string): BookGrouping {
  const normalized = normalizedTitle(title);
  const separate = normalized.match(SEPARATE_VOLUME);
  if (separate) {
    const volume = chineseNumber(separate[2]!);
    const suffix = separate[3]?.trim();
    const datasetTitle = `${separate[1]!.trim()}${suffix ? ` ${suffix}` : ""}`;
    return {
      datasetTitle,
      datasetId: datasetIdForTitle(datasetTitle),
      datasetType: "book-series",
      ...(volume ? { sourceVolumeNumber: volume } : {}),
    };
  }
  const all = normalized.match(ALL_VOLUMES);
  if (all) {
    const datasetTitle = normalized.replace(all[0], "").replace(/\s+/g, " ").trim();
    const total = chineseNumber(all[1]!);
    return {
      datasetTitle,
      datasetId: datasetIdForTitle(datasetTitle),
      datasetType: "book-series",
      ...(total ? { declaredTotalVolumes: total } : {}),
    };
  }
  const range = normalized.match(VOLUME_RANGE);
  if (range) {
    const datasetTitle = normalized.replace(range[0], "").replace(/\s+/g, " ").trim();
    const total = chineseNumber(range[1]!);
    return {
      datasetTitle,
      datasetId: datasetIdForTitle(datasetTitle),
      datasetType: "book-series",
      ...(total ? { declaredTotalVolumes: total } : {}),
    };
  }
  return {
    datasetTitle: normalized,
    datasetId: datasetIdForTitle(normalized),
    datasetType: "book",
  };
}

export function volumeNumberFromTitle(title: string): number | undefined {
  const match = normalizedTitle(title).match(VOLUME_REFERENCE);
  return match ? chineseNumber(match[1]!) : undefined;
}

function volumeNumberFromHeading(title: string): number | undefined {
  const match = normalizedTitle(title).match(VOLUME_HEADING);
  return match ? chineseNumber(match[1]!) : undefined;
}

export function splitChapterRanges(
  chapters: JojoCanonicalChapter[],
  toc: JojoTocNode[],
  declaredTotalVolumes?: number,
): Array<{ volumeNumber: number; chapterIds: Set<string> }> {
  if (!declaredTotalVolumes || declaredTotalVolumes < 2) return [];
  void toc;
  const candidates: Array<{ volumeNumber: number; chapterIndex: number }> = [];
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const volumeNumber = volumeNumberFromHeading(chapter.title);
    if (volumeNumber && volumeNumber <= declaredTotalVolumes) {
      candidates.push({ volumeNumber, chapterIndex });
    }
  }
  const firstMarkerByVolume = new Map<number, { volumeNumber: number; chapterIndex: number }>();
  for (const candidate of candidates.sort((left, right) => left.chapterIndex - right.chapterIndex)) {
    if (!firstMarkerByVolume.has(candidate.volumeNumber)) {
      firstMarkerByVolume.set(candidate.volumeNumber, candidate);
    }
  }
  const markers = Array.from({ length: declaredTotalVolumes }, (_, index) => (
    firstMarkerByVolume.get(index + 1)
  ));
  if (markers.some((marker) => !marker)) return [];
  const completeMarkers = markers as Array<{ volumeNumber: number; chapterIndex: number }>;
  if (completeMarkers.some((marker, index) => (
    index > 0 && marker.chapterIndex <= completeMarkers[index - 1]!.chapterIndex
  ))) return [];

  return completeMarkers.map((marker, markerIndex) => {
    const start = markerIndex === 0 ? 0 : marker.chapterIndex;
    const end = completeMarkers[markerIndex + 1]?.chapterIndex ?? chapters.length;
    return {
      volumeNumber: marker.volumeNumber,
      chapterIds: new Set(
        chapters.slice(start, end).map((chapter) => chapter.id),
      ),
    };
  }).filter((range) => range.chapterIds.size > 0);
}

export function pruneToc(nodes: JojoTocNode[], chapterIds: Set<string>): JojoTocNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? pruneToc(node.children, chapterIds) : [];
    const targetsIncluded = node.targetId ? chapterIds.has(node.targetId) : false;
    if (!targetsIncluded && children.length === 0) return [];
    return [{
      ...node,
      ...(!targetsIncluded ? { targetId: undefined, anchorId: undefined } : {}),
      ...(children.length > 0 ? { children } : { children: undefined }),
    }];
  });
}
