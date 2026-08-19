export const BOOK_COVER_TONES = ["red", "ink", "beige", "brick", "gray"] as const;

export function bookCoverTone(value: string): (typeof BOOK_COVER_TONES)[number] {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return BOOK_COVER_TONES[hash % BOOK_COVER_TONES.length]!;
}

export function issueLabel(id: string): string {
  if (/^\d{8}$/.test(id)) return `${id.slice(0, 4)} 年 ${Number(id.slice(4, 6))} 月 ${Number(id.slice(6, 8))} 日`;
  if (/^\d{6}$/.test(id)) return `${id.slice(0, 4)} 年第 ${Number(id.slice(4))} 期`;
  return id;
}
