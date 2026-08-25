import type { JojoDatasetIndex, JojoDatasetItemSummary, JojoItemManifest } from "./types.js";

export type TimesContentStatus = "full" | "partial" | "summary";
export type TimesSourceHealthStatus = "healthy" | "degraded" | "unavailable";
export type TimesUnavailableReason =
  | "source-error"
  | "source-empty"
  | "metadata-only"
  | "full-text-pending"
  | "canonical-missing"
  | "browser-capture-failed";

export interface TimesSourceRef {
  id: string;
  name: string;
  language: string;
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
  translations?: Record<string, unknown>;
}

export interface TimesSourceHealth {
  source: TimesSourceRef;
  status: TimesSourceHealthStatus;
  discovered: number;
  delivered: number;
  full: number;
  summary: number;
  unavailable: number;
  availabilityRate: number;
  fullTextRate: number;
  healthScore: number;
  networkExchanges: number;
  browserAttempts: number;
  browserSucceeded: number;
  browserFailed: number;
  updatedAt: string;
}

export interface TimesUnavailableCase {
  id: string;
  source: TimesSourceRef;
  reason: TimesUnavailableReason;
  stage: "discovery" | "capture" | "canonical";
  message: string;
  title?: string;
  url?: string;
  publishedAt?: string;
}

export interface TimesDeliveryIndex extends JojoDatasetIndex {
  datasetId: "times";
  type: "newspaper";
  items: JojoDatasetItemSummary[];
  updatedAt: string;
  window: {
    from: string;
    to: string;
    hours: number;
  };
  sourceHealth: TimesSourceHealth[];
  unavailableCases: TimesUnavailableCase[];
}

export interface TimesDateMetadata extends Record<string, unknown> {
  formatVersion: "jojo-times-date-metadata/1";
  issueDate: string;
  generatedAt: string;
  articles: TimesDeliveryArticle[];
}

export interface TimesDateManifest extends Omit<JojoItemManifest, "metadata"> {
  datasetId: "times";
  type: "newspaper";
  metadata: TimesDateMetadata;
}
