import rmrbImage from "./assets/periodicals/people-daily-brand.jpg";
import ckxxImage from "./assets/periodicals/reference-news-brand.jpg";
import hqImage from "./assets/periodicals/red-flag-brand.jpg";
import rmhbImage from "./assets/periodicals/china-pictorial-brand.jpg";
import sjzsImage from "./assets/periodicals/world-affairs-brand.jpg";
import type { PublicationName } from "../archive/publications";

export interface PeriodicalEntry {
  id: PublicationName;
  title: string;
  englishTitle: string;
  years: string;
  kind: "报纸" | "杂志";
  image: string;
  imagePosition?: string;
}

export const PERIODICALS: PeriodicalEntry[] = [
  { id: "rmrb", title: "人民日报", englishTitle: "PEOPLE'S DAILY", years: "1946 — 至今", kind: "报纸", image: rmrbImage },
  { id: "ckxx", title: "参考消息", englishTitle: "REFERENCE NEWS", years: "1957 — 1998", kind: "报纸", image: ckxxImage },
  { id: "hq", title: "红旗", englishTitle: "RED FLAG", years: "1958 — 1988", kind: "杂志", image: hqImage },
  { id: "rmhb", title: "人民画报", englishTitle: "CHINA PICTORIAL", years: "1950 — 1976", kind: "杂志", image: rmhbImage },
  { id: "sjzs", title: "世界知识", englishTitle: "WORLD AFFAIRS", years: "1934 — 2025", kind: "杂志", image: sjzsImage },
];

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
