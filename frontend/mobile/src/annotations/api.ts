import { createAnnotationApi } from "@jojo/content/annotations";
export type {
  AnnotationComment,
  AnnotationReportReason,
  AnnotationSubject,
  AnnotationThread,
  AnnotationVisibility,
  BookAnnotationOptions,
  BookAnnotationProgress,
  TextAnchor,
} from "@jojo/content/annotations";
export { ANNOTATION_REPORT_LABELS } from "@jojo/content/annotations";

let authModule: Promise<typeof import("../account/auth")> | undefined;
function loadAuth() {
  return authModule ??= import("../account/auth");
}

const api = createAnnotationApi({
  rpc: async (name, params, expectedUserId, signal) => {
    const { mobileAuthClient } = await loadAuth();
    const { data, error } = await mobileAuthClient.auth.getSession();
    const session = data.session;
    if (error || session?.user.id !== expectedUserId || !session.access_token) throw new Error("登录状态已变化，请重新打开笔记");
    const base = process.env.EXPO_PUBLIC_READER_API_BASE?.replace(/\/$/, "") || "https://beta.jojokanbao.cn";
    const response = await fetch(`${base}/api/v1/annotations`, {
      method: "POST", headers: { "Authorization": authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: name, params }), signal,
    });
    const result = await response.json();
    return response.ok ? { data: result, error: null }
      : { data: null, error: { message: result.error?.message || "阅读笔记服务暂时不可用" } };
  },
  getCurrentUserId: async () => {
    const { mobileAuthClient } = await loadAuth();
    const { data, error } = await mobileAuthClient.auth.getSession();
    return error ? null : data.session?.user.id ?? null;
  },
  currentPath: () => "/library",
});

export const {
  loadAnnotationThreads,
  loadMyBookAnnotations,
  loadPublicBookAnnotations,
  createAnnotation,
  addAnnotationComment,
  reportAnnotationComment,
  deleteMyAnnotationMark,
} = api;
