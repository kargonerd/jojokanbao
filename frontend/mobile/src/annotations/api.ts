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
    const authorization = `Bearer ${session.access_token}`;
    // The shared disclosure threshold lives in the database, so every operation
    // is a plain authenticated RPC against the reader's own session.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = (mobileAuthClient as any).rpc(name, params).setHeader("Authorization", authorization);
    return signal ? request.abortSignal(signal) : request;
  },
  getCurrentUserId: async () => {
    const { mobileAuthClient, useMobileAuthStore } = await loadAuth();
    const { data, error } = await mobileAuthClient.auth.getSession();
    const sessionUserId = error ? null : data.session?.user.id ?? null;
    if (sessionUserId) return sessionUserId;
    // The SDK silently drops its stored session when the startup token refresh
    // fails transiently, while the app still shows the reader signed in from
    // the persisted snapshot. Re-seed the SDK from that snapshot instead of
    // reporting a signed-in reader as logged out; setSession refreshes an
    // expired access token itself.
    const persisted = useMobileAuthStore.getState().session;
    if (!error && persisted?.access_token && persisted.refresh_token && persisted.user?.id) {
      try {
        const { data: seeded, error: seedError } = await mobileAuthClient.auth.setSession({
          access_token: persisted.access_token,
          refresh_token: persisted.refresh_token,
        });
        const seededUserId = seedError ? null : seeded.session?.user.id ?? null;
        if (seededUserId === persisted.user.id) return seededUserId;
      } catch { /* fall through to the signed-out answer */ }
    }
    return sessionUserId;
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
  setAnnotationCommentLike,
  deleteMyAnnotationMark,
  deleteMyAnnotationComment,
} = api;
