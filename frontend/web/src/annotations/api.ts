import { analytics } from "@jojo/analytics";
import { createAnnotationApi } from "@jojo/content/annotations";
export type { BookAnnotationOptions, BookAnnotationProgress } from "@jojo/content/annotations";

// Keep public content independent of account configuration until an authenticated
// annotation feature actually invokes the shared API.
let authModule: Promise<typeof import("../account/auth")> | undefined;
function loadAuth() {
  return authModule ??= import("../account/auth");
}

function reportFailure(operation: string, reason: unknown, route: "direct" | "proxy"): void {
  const detail = reason as { code?: unknown; status?: unknown; name?: unknown } | null;
  analytics.track("annotation_failed", {
    operation,
    route,
    error_code: typeof detail?.code === "string" ? detail.code : "",
    error_name: typeof detail?.name === "string" ? detail.name : "Error",
    http_status: typeof detail?.status === "number" ? detail.status : 0,
  });
}

const api = createAnnotationApi({
  rpc: async (name, params, expectedUserId, signal) => {
    const { authClient, supabaseRouteState } = await loadAuth();
    const { data, error } = await authClient.auth.getSession();
    const session = data.session;
    if (error || session?.user.id !== expectedUserId || !session.access_token) {
      reportFailure(name, { code: "session_changed" }, supabaseRouteState());
      throw new Error("登录状态已变化，请重新打开笔记");
    }
    const authorization = `Bearer ${session.access_token}`;
    // The shared disclosure threshold lives in the database, so every operation
    // is a plain authenticated RPC against the reader's own session.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = (authClient as any).rpc(name, params).setHeader("Authorization", authorization);
    try {
      const result = await (signal ? request.abortSignal(signal) : request);
      if (result?.error) reportFailure(name, result.error, supabaseRouteState());
      return result;
    } catch (reason) {
      // A failed connection is the interesting case: it tells us whether the
      // reader was on the direct path or already behind the proxy.
      reportFailure(name, reason, supabaseRouteState());
      throw reason;
    }
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
