import type {
  JojoBookSearchBlock,
  JojoBookSearchIndex,
} from "./types.js";

export const JOJO_BOOK_SEARCH_BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,blockquote,li,figcaption";

/** Stable fallback used when the source paragraph or heading has no HTML id. */
export function bookSearchBlockAnchorId(targetId: string, blockNumber: number): string {
  return `jojo-search-block:${targetId}:${Math.max(1, Math.floor(blockNumber))}`;
}

export interface JojoBookSearchMatch {
  anchorId?: string;
  excerpt: string;
  matchText: string;
  order: number;
  targetId: string;
}

export interface JojoBookSearchOptions {
  after?: number;
  before?: number;
  limit?: number;
}

export function normalizedBookSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function blockMatch(
  block: JojoBookSearchBlock,
  query: string,
  options: Required<JojoBookSearchOptions>,
): { match: JojoBookSearchMatch; score: number } | undefined {
  const text = block.text.replace(/\s+/g, " ").trim();
  const needle = normalizedBookSearchText(query);
  const normalized = normalizedBookSearchText(text);
  const normalizedIndex = normalized.indexOf(needle);
  if (normalizedIndex < 0) return undefined;

  const directNeedle = query.trim().toLocaleLowerCase();
  const directIndex = text.toLocaleLowerCase().indexOf(directNeedle);
  const matchIndex = directIndex >= 0
    ? directIndex
    : Math.min(normalizedIndex, text.length);
  const matchLength = directIndex >= 0
    ? query.trim().length
    : Math.min(needle.length, text.length - matchIndex);
  const excerptStart = Math.max(0, matchIndex - options.before);
  const excerptEnd = Math.min(
    text.length,
    matchIndex + matchLength + options.after,
  );
  let occurrenceCount = 0;
  for (let offset = 0; (offset = normalized.indexOf(needle, offset)) >= 0;) {
    occurrenceCount += 1;
    offset += Math.max(1, needle.length);
  }
  const metadataPenalty = /(?:^|\s)(?:版权信息|书名|isbn|出版社|出版时间|版权所有)\s*[:：]?/i.test(text)
    ? 1_000
    : 0;
  const outlinePenalty = text.length <= 180 && /(?:目录|第[一二三四五六七八九十百零\d]+[章节篇卷])/.test(text)
    ? 300
    : 0;
  const exactPenalty = normalized === needle ? 800 : 0;
  return {
    match: {
      targetId: block.targetId,
      order: block.order,
      ...(block.anchorId ? { anchorId: block.anchorId } : {}),
      excerpt: `${excerptStart > 0 ? "…" : ""}${text.slice(excerptStart, excerptEnd)}${excerptEnd < text.length ? "…" : ""}`,
      matchText: text.slice(matchIndex, matchIndex + matchLength),
    },
    score: Math.min(text.length, 1_200)
      + Math.min(occurrenceCount, 12) * 80
      - metadataPenalty
      - outlinePenalty
      - exactPenalty,
  };
}

/** Fast exact-text lookup over the static index shipped beside one book. */
export function searchJojoBookIndex(
  index: JojoBookSearchIndex,
  query: string,
  options: JojoBookSearchOptions = {},
): JojoBookSearchMatch[] {
  if (!normalizedBookSearchText(query)) return [];
  const resolved = {
    before: Math.max(0, Math.floor(options.before ?? 70)),
    after: Math.max(0, Math.floor(options.after ?? 120)),
    limit: Math.max(1, Math.min(100, Math.floor(options.limit ?? 30))),
  };
  const matches: Array<{ match: JojoBookSearchMatch; score: number }> = [];
  for (const block of index.blocks) {
    const ranked = blockMatch(block, query, resolved);
    if (!ranked) continue;
    const insertAt = matches.findIndex((candidate) => (
      ranked.score > candidate.score
      || (ranked.score === candidate.score && ranked.match.order < candidate.match.order)
    ));
    if (insertAt >= 0) matches.splice(insertAt, 0, ranked);
    else if (matches.length < resolved.limit) matches.push(ranked);
    if (matches.length > resolved.limit) matches.pop();
  }
  return matches
    .map(({ match }) => match);
}
