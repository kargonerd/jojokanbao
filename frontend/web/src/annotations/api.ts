import { createAnnotationApi } from "@jojo/content/annotations";
import { agentGatewayUrl } from "../api/agentGateway";
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
    const response = await fetch(agentGatewayUrl("/api/v1/annotations"), {
      method: "POST", headers: { "Authorization": authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: name, params }), signal,
    });
    const result = await response.json();
    return response.ok ? { data: result, error: null }
      : { data: null, error: { message: result.error?.message || "阅读笔记服务暂时不可用" } };
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
} = api;
