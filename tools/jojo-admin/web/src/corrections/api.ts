import { apiGet, apiPost } from "../lib/api";

export type CorrectionStatus = "pending" | "in_progress" | "resolved" | "dismissed";
export type CorrectionFilter = CorrectionStatus | "all";
export interface CorrectionItem {
  id: string; contentType: string; contentId: string; contentTitle: string; contentUrl: string;
  sectionId?: string; locationLabel?: string; quote?: string; category: string; details: string;
  status: CorrectionStatus; createdAt: string; reviewedAt?: string; resolutionNote?: string;
}
export const correctionsApi = {
  async list(status: CorrectionFilter, offset: number): Promise<{ items: CorrectionItem[]; total: number }> {
    return apiGet(`/api/content-corrections?status=${encodeURIComponent(status)}&offset=${offset}`);
  },
  async review(id: string, status: CorrectionStatus, note: string): Promise<void> {
    await apiPost(`/api/content-corrections/${encodeURIComponent(id)}`, { status, note });
  },
};
