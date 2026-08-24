import type { JojoDatasetIndex, JojoDatasetItemSummary, JojoItemManifest } from "./types.js";

export const NEWS_TIMELINE_PROFILE = "jojo-news-timeline/1";

export interface NewsSourceRef {
  id: string;
  name: string;
  language: string;
}

export interface NewsDeliveryArticle {
  id: string;
  title: string;
  summary?: string | null;
  url?: string | null;
  publishedAt: string;
  issueDate: string;
  language: string;
  source: NewsSourceRef;
  authors: string[];
  categories: string[];
  publisherCategories: string[];
  articleObject: string;
  translations?: Record<string, unknown>;
}

export interface NewsPublisherIndex extends JojoDatasetIndex {
  type: "newspaper";
  items: JojoDatasetItemSummary[];
  contentProfile: typeof NEWS_TIMELINE_PROFILE;
  updatedAt: string;
}

export interface NewsDateMetadata extends Record<string, unknown> {
  formatVersion: "jojo-news-date-metadata/1";
  issueDate: string;
  generatedAt: string;
  source: NewsSourceRef;
  articles: NewsDeliveryArticle[];
}

export interface NewsDateManifest extends Omit<JojoItemManifest, "metadata"> {
  type: "newspaper";
  metadata: NewsDateMetadata;
}
