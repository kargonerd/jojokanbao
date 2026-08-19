import rmrbImage from "./assets/periodicals/people-daily-brand.jpg";
import ckxxImage from "./assets/periodicals/reference-news-brand.jpg";
import hqImage from "./assets/periodicals/red-flag-brand.jpg";
import rmhbImage from "./assets/periodicals/china-pictorial-brand.jpg";
import sjzsImage from "./assets/periodicals/world-affairs-brand.jpg";
import type { PublicationName } from "../archive/publications";
export { BOOK_COVER_TONES, bookCoverTone, issueLabel } from "./bookCatalog";

export interface PeriodicalEntry {
  id: PublicationName;
  title: string;
  englishTitle: string;
  years: string;
  kind: "报纸" | "杂志";
  image: string;
  imagePosition?: string;
  defaultIssueId: string;
}

export const PERIODICALS: PeriodicalEntry[] = [
  { id: "rmrb", title: "人民日报", englishTitle: "PEOPLE'S DAILY", years: "1946 — 至今", kind: "报纸", image: rmrbImage, defaultIssueId: "19761009" },
  { id: "ckxx", title: "参考消息", englishTitle: "REFERENCE NEWS", years: "1957 — 1998", kind: "报纸", image: ckxxImage, defaultIssueId: "19760910" },
  { id: "hq", title: "红旗", englishTitle: "RED FLAG", years: "1958 — 1988", kind: "杂志", image: hqImage, defaultIssueId: "196419" },
  { id: "rmhb", title: "人民画报", englishTitle: "CHINA PICTORIAL", years: "1950 — 1976", kind: "杂志", image: rmhbImage, defaultIssueId: "197292" },
  { id: "sjzs", title: "世界知识", englishTitle: "WORLD AFFAIRS", years: "1934 — 2025", kind: "杂志", image: sjzsImage, defaultIssueId: "196513" },
];
