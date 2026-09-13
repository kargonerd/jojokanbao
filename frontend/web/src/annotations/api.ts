import { createAnnotationApi } from "@jojo/content/annotations";
export type { BookAnnotationOptions, BookAnnotationProgress } from "@jojo/content/annotations";

// Keep public content independent of account configuration until an authenticated
// annotation feature actually invokes the shared API.
let authModule: Promise<typeof import("../account/auth")> | undefined;
function loadAuth() {
  return authModule ??= import("../account/auth");
}

const api = createAnnotationApi({
  rpc: async (name, params, expectedUserId, signal) => {
    const { authClient } = await loadAuth();
    const { data, error } = await authClient.auth.getSession();
    const session = data.session;
    if (error || session?.user.id !== expectedUserId || !session.access_token) throw new Error("登录状态已变化，请重新打开笔记");
    const authorization = `Bearer ${session.access_token}`;
    // The shared disclosure threshold lives in the database, so every operation
    // is a plain authenticated RPC against the reader's own session.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = (authClient as any).rpc(name, params).setHeader("Authorization", authorization);
    return signal ? request.abortSignal(signal) : request;
  },
  getCurrentUserId: async () => {
    const { authClient } = await loadAuth();
    const { data, error } = await authClient.auth.getSession();
    return error ? null : data.session?.user.id ?? null;
  },
  currentPath: () => `${window.location.pathname}${window.location.search}`,
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
