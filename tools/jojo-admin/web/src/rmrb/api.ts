export type RmrbDecision = {
  decision: "accept" | "reject";
  content?: string;
  reason?: string;
  images?: RmrbDecisionImage[];
};

export type RmrbDecisionImage = {
  name: string;
  mediaType: string;
  dataUrl?: string;
  sha256?: string;
  size?: number;
};

export type RmrbReviewItem = {
  date: string;
  page: number;
  peopleDataOrdinal: number;
  title: string;
  status: string;
  rawRecoveryClass: string;
  peopleDataHref?: string;
  decision?: RmrbDecision;
};

export type RmrbQueue = {
  success: boolean;
  total: number;
  offset: number;
  limit: number;
  sort: "date-ascending";
  items: RmrbReviewItem[];
};

export type RmrbStats = {
  success: boolean;
  total: number;
  counts: { pending: number; pendingPublication: number };
};

export type RmrbSourceStatus = {
  success: true;
  status: "idle" | "checking" | "downloading" | "building" | "ready" | "failed";
  source: "huggingface";
  message: string;
  completed: number;
  total: number;
  revision: string | null;
  cached: boolean;
  error: string | null;
};

export type RmrbSyncTarget = "huggingface" | "b2";

export type RmrbSyncProgress = {
  status: "idle" | "running" | "succeeded" | "failed";
  phase: "idle" | "preparing" | "huggingface" | "b2" | "complete" | "failed";
  message: string;
  completed: number;
  total: number;
  percent: number;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  publishedChanges: number;
};

export type RmrbSyncStatus = {
  success: true;
  configured: Record<RmrbSyncTarget, boolean>;
  state: {
    targets?: Partial<Record<RmrbSyncTarget, {
      publishedAt: string;
      acceptedCount: number;
      desiredSha256: string;
    }>>;
  };
  progress: RmrbSyncProgress;
};

export type RmrbSyncResult = {
  success: true;
  stagedCount: number;
  pendingPublication: number;
  canonicalChanges: number;
  publishedChanges: number;
  results: Partial<Record<RmrbSyncTarget, object>>;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
  }
  return payload as T;
}

export const rmrbReviewApi = {
  queue(offset: number, limit: number, query: string) {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      pendingOnly: "1",
    });
    if (query.trim()) params.set("q", query.trim());
    return requestJson<RmrbQueue>(`/api/rmrb-review/queue?${params}`);
  },
  stats() {
    return requestJson<RmrbStats>("/api/rmrb-review/stats");
  },
  sourceStatus() {
    return requestJson<RmrbSourceStatus>("/api/rmrb-review/source");
  },
  syncStatus() {
    return requestJson<RmrbSyncStatus>("/api/rmrb-review/sync");
  },
  sync(targets: RmrbSyncTarget[]) {
    return requestJson<RmrbSyncResult>("/api/rmrb-review/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
  },
  decide(
    item: RmrbReviewItem,
    decision: "accept" | "reject",
    content: string,
    reason: string,
    images: RmrbDecisionImage[] = [],
  ) {
    return requestJson<{ success: true; decision: RmrbDecision }>(
      "/api/rmrb-review/decision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: item.date,
          page: item.page,
          peopleDataOrdinal: item.peopleDataOrdinal,
          decision,
          content,
          reason,
          images,
        }),
      },
    );
  },
};
