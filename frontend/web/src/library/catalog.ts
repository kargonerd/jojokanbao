import rmrbImage from "../../../packages/content/assets/periodicals/people-daily-brand.jpg";
import ckxxImage from "../../../packages/content/assets/periodicals/reference-news-brand.jpg";
import hqImage from "../../../packages/content/assets/periodicals/red-flag-brand.jpg";
import rmhbImage from "../../../packages/content/assets/periodicals/china-pictorial-brand.jpg";
import sjzsImage from "../../../packages/content/assets/periodicals/world-affairs-brand.jpg";
import { ARCHIVE_PUBLICATIONS, type ArchivePublicationName } from "@jojo/content";
export { BOOK_COVER_TONES, bookCoverTone, issueLabel } from "./bookCatalog";

export interface PeriodicalEntry {
  id: ArchivePublicationName;
  title: string;
  englishTitle: string;
  years: string;
  kind: "报纸" | "杂志";
  image: string;
  imagePosition?: string;
  defaultIssueId: string;
}

const periodicalImages: Record<ArchivePublicationName, string> = {
  rmrb: rmrbImage,
  ckxx: ckxxImage,
  hq: hqImage,
  rmhb: rmhbImage,
  sjzs: sjzsImage,
};

export const PERIODICALS: PeriodicalEntry[] = ARCHIVE_PUBLICATIONS.map((publication) => ({
  id: publication.id,
  title: publication.title,
  englishTitle: publication.englishTitle,
  years: publication.years,
  kind: publication.kind,
  image: periodicalImages[publication.id],
  defaultIssueId: publication.defaultIssueId,
}));
