import type { JojoAssetDescriptor, JojoDatasetIndex, JojoDatasetItemSummary, JojoItemManifest } from "./types.js";

export type TimesContentStatus = "full";
export type TimesSourceHealthStatus = "healthy" | "degraded" | "unavailable";

export interface TimesSourceRef {
  id: string;
  name: string;
  language: string;
}

export interface TimesArticleTranslation {
  language: string;
  title: string;
  summary?: string | null;
  articleObject: string;
  provider: "google-gemini-api";
  model: string;
  stale?: boolean;
}

export interface TimesDeliveryArticle {
  id: string;
  title: string;
  summary?: string | null;
  contentStatus: TimesContentStatus;
  url?: string | null;
  publishedAt: string;
  issueDate: string;
  language: string;
  source: TimesSourceRef;
  publisherSections?: Array<{ id: string; name: string }>;
  articleObject: string;
  assets: JojoAssetDescriptor[];
  translations?: Record<string, TimesArticleTranslation>;
}

export interface TimesTimelineDayRef {
  date: string;
  object: string;
  articleCount: number;
}

export interface TimesTimelineIndex {
  formatVersion: "jojo-news-timeline-index/1";
  updatedAt: string;
  dates: TimesTimelineDayRef[];
  sources: TimesSourceRef[];
}

export interface TimesTimelineDay {
  formatVersion: "jojo-news-timeline-day/1";
  date: string;
  updatedAt: string;
  articles: TimesDeliveryArticle[];
}

export interface TimesSourceIndex extends JojoDatasetIndex {
  datasetId: string;
  type: "newspaper";
  source: TimesSourceRef;
  items: JojoDatasetItemSummary[];
  updatedAt: string;
}

export interface TimesDateMetadata extends Record<string, unknown> {
  formatVersion: "jojo-news-source-date/1";
  issueDate: string;
  generatedAt: string;
  source: TimesSourceRef;
  articles: TimesDeliveryArticle[];
}

export interface TimesDateManifest extends Omit<JojoItemManifest, "metadata"> {
  datasetId: string;
  type: "newspaper";
  metadata: TimesDateMetadata;
}

export interface TimesSourceHealth {
  source: TimesSourceRef;
  status: TimesSourceHealthStatus;
  discovered: number;
  delivered: number;
  full: number;
  unavailable: number;
  availabilityRate: number;
  fullTextRate: number;
  healthScore: number;
  networkExchanges: number;
  pageAttempts: number;
  pageSucceeded: number;
  pageFailed: number;
  imageAssets: number;
  updatedAt: string;
}
