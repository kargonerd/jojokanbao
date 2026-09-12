import type { JojoAuthClient } from "./client";

export type ContentCorrectionCategory = "typo" | "missing_page" | "wrong_page" | "layout" | "other";
export type ContentCorrectionStatus = "pending" | "in_progress" | "resolved" | "dismissed";

export interface ContentCorrectionSource {
  contentType: "book" | "newspaper" | "magazine" | "article";
  contentId: string;
  contentTitle: string;
  contentUrl: string;
  sectionId?: string;
  locationLabel?: string;
  quote?: string;
}

export interface ContentCorrection extends ContentCorrectionSource {
  id: string;
  category: ContentCorrectionCategory;
  details: string;
  status: ContentCorrectionStatus;
  createdAt: string;
  reviewedAt?: string | null;
  resolutionNote?: string | null;
}

export const contentCorrectionCategoryLabels: Record<ContentCorrectionCategory, string> = {
  typo: "文字错误", missing_page: "缺页 / 缺内容", wrong_page: "错页 / 顺序错误", layout: "排版问题", other: "其他问题",
};
export const contentCorrectionStatusLabels: Record<ContentCorrectionStatus, string> = {
  pending: "待处理", in_progress: "核查中", resolved: "已修正", dismissed: "已答复",
};

// A stable key for retrying one submission; it is never used as an auth token.
export function createCorrectionRequestId(): string {
  return `correction-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function validateContentCorrection(source: ContentCorrectionSource, details: string): void {
  if (!source.contentId.trim() || source.contentId.length > 512 || !source.contentTitle.trim() || source.contentTitle.length > 300) {
    throw new Error("缺少有效的内容信息，请返回阅读页重试。");
  }
  if (!/^\/(?!\/)/.test(source.contentUrl) || /[\\\u0000-\u001f\u007f]/.test(source.contentUrl) || source.contentUrl.length > 1024) {
    throw new Error("阅读位置无效，请返回阅读页重试。");
  }
  if ((source.sectionId?.length || 0) > 512 || (source.locationLabel?.length || 0) > 300 || (source.quote?.length || 0) > 4000) {
    throw new Error("位置或摘录过长，请缩短后重试。");
  }
  if (details.trim().length < 2 || details.trim().length > 2000) {
    throw new Error("请填写 2 至 2000 字的问题说明。");
  }
}

interface RpcResult { data: unknown; error: { message?: string; code?: string } | null }
interface CorrectionRpcClient { rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult> }

function throwRpcError(error: RpcResult["error"]): void {
  if (!error) return;
  if (error.code === "PGRST202" || error.code === "42883") throw new Error("纠错服务尚未启用，请稍后重试。");
  if (error.code === "42501") throw new Error("登录状态已过期，请重新登录后提交。");
  if (error.code === "53300") throw new Error("今天提交的纠错较多，请明天再试。");
  throw new Error("纠错服务暂时不可用，请稍后重试。填写的内容仍会保留。");
}

function isCorrection(value: unknown): value is ContentCorrection {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ContentCorrection>;
  return typeof record.id === "string" && typeof record.contentId === "string"
    && typeof record.contentTitle === "string" && typeof record.details === "string"
    && typeof record.createdAt === "string" && record.status !== undefined
    && Object.hasOwn(contentCorrectionStatusLabels, record.status);
}

export function createContentCorrectionRepository(client: JojoAuthClient) {
  // Keep new RPC typing local until the deployed database types are regenerated.
  const rpcClient = client as unknown as CorrectionRpcClient;
  return {
    async submit(source: ContentCorrectionSource, category: ContentCorrectionCategory, details: string, requestId: string, expectedUserId: string): Promise<ContentCorrection> {
      validateContentCorrection(source, details);
      if (!expectedUserId) throw new Error("请先登录后提交纠错。");
      if (!Object.hasOwn(contentCorrectionCategoryLabels, category)) throw new Error("请选择问题类型。");
      const { data, error } = await rpcClient.rpc("submit_content_correction", {
        p_request_id: requestId, p_expected_user_id: expectedUserId, p_content_type: source.contentType,
        p_content_id: source.contentId, p_content_title: source.contentTitle,
        p_content_url: source.contentUrl, p_section_id: source.sectionId || null,
        p_location_label: source.locationLabel || null, p_quote: source.quote?.trim() || null,
        p_category: category, p_details: details.trim(),
      });
      throwRpcError(error);
      if (!isCorrection(data)) throw new Error("未能确认纠错已记录，请重试。");
      return data;
    },
    async list(source?: Pick<ContentCorrectionSource, "contentType" | "contentId">): Promise<ContentCorrection[]> {
      const { data, error } = await rpcClient.rpc("get_my_content_corrections", {
        p_content_type: source?.contentType || null, p_content_id: source?.contentId || null,
      });
      throwRpcError(error);
      if (!Array.isArray(data) || !data.every(isCorrection)) throw new Error("暂时无法读取纠错记录。");
      return data;
    },
  };
}
