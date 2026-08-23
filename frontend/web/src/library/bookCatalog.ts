import { formatArchiveIssueLabel } from "@jojo/content";

export const BOOK_COVER_TONES = ["red", "ink", "beige", "brick", "gray"] as const;

export function bookCoverTone(value: string): (typeof BOOK_COVER_TONES)[number] {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return BOOK_COVER_TONES[hash % BOOK_COVER_TONES.length]!;
}

export function issueLabel(id: string): string {
  return formatArchiveIssueLabel(id);
}
