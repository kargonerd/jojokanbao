import { AgentHttpError } from "./auth";
import type { AgentUsageLease, AuthorizedAgentUser, EdgeOneAgentContext } from "./types";

type UsageDecision = {
  allowed?: boolean;
  reason?: string;
  retryAfter?: number;
  limit?: number;
  maxRunSeconds?: number;
};

export async function acquireAgentUsage(
  context: EdgeOneAgentContext,
  user: AuthorizedAgentUser,
): Promise<AgentUsageLease> {
  const environment = context.env ?? process.env;
  const baseUrl = environment.VITE_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const operatorToken = environment.JOJO_OPERATOR_TOKEN?.trim();
  if (!baseUrl || !key || !operatorToken) {
    throw new AgentHttpError(503, "AI 使用限额服务暂时不可用，请稍后重试。");
  }
  const requestId = crypto.randomUUID();
  const body = JSON.stringify({ p_operator_token: operatorToken, p_user_id: user.id, p_request_id: requestId });
  const rpc = async (name: string, signal?: AbortSignal): Promise<Response> => {
    const timeout = AbortSignal.timeout(5_000);
    return fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };
  // Releasing is idempotent and always uses a fresh signal, including when the
  // caller disconnected. A matching lease expires if the database is offline.
  const release = async () => {
    try {
      const response = await rpc("release_agent_usage");
      if (!response.ok) throw new Error("release failed");
    } catch {
      context.tracer?.setAttributes?.({ "agent.usage_release_failed": true });
    }
  };
  let decision: UsageDecision;
  try {
    const response = await rpc("acquire_agent_usage", context.request.signal);
    if (!response.ok) throw new Error("reservation failed");
    decision = await response.json() as UsageDecision;
  } catch {
    // The reservation may have committed before a network timeout.
    await release();
    throw new AgentHttpError(503, "AI 使用限额服务暂时不可用，请稍后重试。");
  }
  if (!decision || typeof decision !== "object") {
    await release();
    throw new AgentHttpError(503, "AI 使用限额服务暂时不可用，请稍后重试。");
  }
  if (decision.allowed === false && ["concurrent", "minute", "daily"].includes(decision.reason ?? "")) {
    const retryAfter = Number.isInteger(decision.retryAfter) && decision.retryAfter! > 0
      ? Math.min(decision.retryAfter!, 86_400) : 60;
    const message = decision.reason === "concurrent"
      ? "你还有一条 AI 回答正在生成，请等待完成或停止后再试。"
      : decision.reason === "daily"
        ? "今天的 AI 使用次数已用完，请在北京时间明天零点后再试。"
        : `AI 提问过于频繁，请在 ${retryAfter} 秒后再试。`;
    throw new AgentHttpError(429, message, `ai_${decision.reason}_limit`, retryAfter);
  }
  if (decision.allowed !== true || !Number.isInteger(decision.maxRunSeconds)
    || decision.maxRunSeconds! < 30 || decision.maxRunSeconds! > 600) {
    await release();
    throw new AgentHttpError(503, "AI 使用限额服务暂时不可用，请稍后重试。");
  }
  return { maxRunSeconds: decision.maxRunSeconds!, release };
}
