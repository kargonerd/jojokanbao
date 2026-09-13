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
  rpc: async (name, params, expectedUserId) => {
    const { mobileAuthClient } = await loadAuth();
    const { data, error } = await mobileAuthClient.auth.getSession();
    const session = data.session;
    if (error || session?.user.id !== expectedUserId || !session.access_token) throw new Error("登录状态已变化，请重新打开笔记");
    // Supabase preserves explicit Authorization when its live session changes.
    const authorization = `Bearer ${session.access_token}`;
    // These deployed RPCs are shared with Web while generated schemas roll out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mobileAuthClient as any).rpc(name, params).setHeader("Authorization", authorization);
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
  createAnnotation,
  addAnnotationComment,
  reportAnnotationComment,
} = api;
