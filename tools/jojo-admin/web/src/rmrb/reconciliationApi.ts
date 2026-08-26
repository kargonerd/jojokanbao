export type RmrbReconciliationResolution =
  | "jsonl_correct"
  | "merge_candidate"
  | "manual_metadata"
  | "defer";

export type RmrbReconciliationCandidate = {
  candidateKey: string;
  date: string;
  page: number;
  ordinal: number;
  title: string;
  editDistance?: number;
  relations: string[];
  peopleDataHref: string;
};

export type RmrbReconciliationDecision = {
  resolution: RmrbReconciliationResolution;
  candidate?: RmrbReconciliationCandidate | null;
  resolvedMetadata?: { date: string; page: number; title: string } | null;
  note?: string;
  reviewedAt: string;
};

export type RmrbReconciliationItem = {
  sourceKey: string;
  date: string;
  page: number;
  ordinal: number;
  title: string;
  content: string;
  signals: string[];
  signalLabels: string[];
  sourcePageHref: string;
  jojoPageHref: string;
  candidates: RmrbReconciliationCandidate[];
  decision?: RmrbReconciliationDecision | null;
};

export type RmrbReconciliationCounts = {
  total: number;
  pending: number;
  reviewed: number;
  jsonlCorrect: number;
  mergeCandidate: number;
  manualMetadata: number;
  deferred: number;
};

export type RmrbReconciliationQueue = {
  success: true;
  source: string;
  decisions: string;
  total: number;
  offset: number;
  limit: number;
  sort: "date-ascending";
  items: RmrbReconciliationItem[];
  counts: RmrbReconciliationCounts;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload as T;
}

export const rmrbReconciliationApi = {
  queue(input: {
    offset: number;
    limit: number;
    query: string;
    signal: string;
    status: string;
  }) {
    const params = new URLSearchParams({
      offset: String(input.offset),
      limit: String(input.limit),
      signal: input.signal,
      status: input.status,
    });
    if (input.query.trim()) params.set("q", input.query.trim());
    return requestJson<RmrbReconciliationQueue>(`/api/rmrb-reconciliation/queue?${params}`);
  },
  decide(
    item: RmrbReconciliationItem,
    input: {
      resolution: RmrbReconciliationResolution;
      candidateKey?: string;
      resolvedDate?: string;
      resolvedPage?: number;
      resolvedTitle?: string;
      note?: string;
    },
  ) {
    return requestJson<{ success: true; decision: RmrbReconciliationDecision }>(
      "/api/rmrb-reconciliation/decision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: item.date,
          page: item.page,
          ordinal: item.ordinal,
          ...input,
        }),
      },
    );
  },
  undo(item: RmrbReconciliationItem) {
    return requestJson<{ success: true; removed: boolean }>(
      "/api/rmrb-reconciliation/decision",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: item.date,
          page: item.page,
          ordinal: item.ordinal,
        }),
      },
    );
  },
};
