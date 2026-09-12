import { createAnnotationApi } from "@jojo/content/annotations";
export type { BookAnnotationOptions, BookAnnotationProgress } from "@jojo/content/annotations";

// Keep public content independent of account configuration until an authenticated
// annotation feature actually invokes the shared API.
let authModule: Promise<typeof import("../account/auth")> | undefined;
function loadAuth() {
  return authModule ??= import("../account/auth");
}

const api = createAnnotationApi({
  rpc: async (name, params, expectedUserId) => {
    const { authClient } = await loadAuth();
    const { data, error } = await authClient.auth.getSession();
    const session = data.session;
    if (error || session?.user.id !== expectedUserId || !session.access_token) throw new Error("登录状态已变化，请重新打开笔记");
    // Supabase preserves explicit Authorization when its live session changes.
    const authorization = `Bearer ${session.access_token}`;
    // RPC rollout is intentionally independent of generated database typings.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (authClient as any).rpc(name, params).setHeader("Authorization", authorization);
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
  createAnnotation,
  addAnnotationComment,
  reportAnnotationComment,
  setAnnotationCommentLike,
  deleteMyAnnotationMark,
} = api;
