import { match } from "pinyin-pro";

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[üǖǘǚǜ]/g, "v")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[\s\p{P}]/gu, "");
}

function literalScore(title: string, query: string): number {
  const directIndex = title.indexOf(query);
  if (directIndex >= 0) return directIndex + (title.length - query.length) / 100;
  let titleIndex = 0;
  let gaps = 0;
  for (const character of query) {
    const foundAt = title.indexOf(character, titleIndex);
    if (foundAt < 0) return Number.POSITIVE_INFINITY;
    gaps += foundAt - titleIndex;
    titleIndex = foundAt + character.length;
  }
  return 100 + gaps + (title.length - query.length) / 100;
}

const scoreCache = new Map<string, number>();

/** Literal titles rank first, followed by full pinyin, initials and skipped words. */
export function fuzzyBookTitleScore(title: string, query: string): number {
  const normalizedTitle = normalize(title);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;
  const literal = literalScore(normalizedTitle, normalizedQuery);
  if (Number.isFinite(literal)) return literal;
  if (!/[a-z]/.test(normalizedQuery) || !/\p{Script=Han}/u.test(normalizedTitle)
    || normalizedQuery.length > normalizedTitle.length * 6) return Number.POSITIVE_INFINITY;

  const cacheKey = JSON.stringify([normalizedTitle, normalizedQuery]);
  const cached = scoreCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let score = Number.POSITIVE_INFINITY;
  for (const [index, options] of ([
    { precision: "every", continuous: true },
    { precision: "first", continuous: true },
    { precision: "every", continuous: false },
    { precision: "first", continuous: false },
  ] as const).entries()) {
    const positions = match(normalizedTitle, normalizedQuery, { ...options, lastPrecision: "start", v: true });
    if (!positions?.length) continue;
    const start = positions[0]!;
    const gaps = positions[positions.length - 1]! - start + 1 - positions.length;
    score = 200 + index * 100 + start + gaps + (normalizedTitle.length - positions.length) / 100;
    break;
  }
  // Search terms are transient; keep memory bounded across long library sessions.
  if (scoreCache.size >= 1024) scoreCache.delete(scoreCache.keys().next().value!);
  scoreCache.set(cacheKey, score);
  return score;
}
