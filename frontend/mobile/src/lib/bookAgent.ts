const AGENT_URL = process.env.EXPO_PUBLIC_AGENT_API_URL?.trim()
  || "https://agent-global.jojokanbao.cn/rag";

export interface MobileBookAgentRequest {
  datasetId: string;
  itemId: string;
  manifestObject: string;
  question: string;
  conversationId?: string;
  history?: MobileBookAgentMessage[];
}

export interface MobileBookAgentReference {
  citationId?: string;
  datasetId?: string;
  itemId?: string;
  datasetTitle?: string;
  itemTitle?: string;
  targetId?: string;
  anchorId?: string;
  title?: string;
  excerpt?: string;
  fragmentObject?: string;
}

export interface MobileBookAgentMessage {
  role: "user" | "assistant";
  content: string;
  references?: MobileBookAgentReference[];
}

type AgentEvent = Record<string, unknown>;

function conversationId(): string {
  return `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 36);
}

export async function mobileAccessToken(): Promise<string> {
  const { mobileAuthClient } = await import("../account/auth");
  const { data, error } = await mobileAuthClient.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("请先登录后使用 AI");
  return token;
}

export function parseAgentSseFrames(
  value: string,
  onEvent: (eventName: string, payload: AgentEvent) => void,
): string {
  const normalized = value.replaceAll("\r\n", "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  for (const frame of frames) {
    const lines = frame.split("\n");
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const payloadText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!payloadText) continue;
    const payload = JSON.parse(payloadText) as AgentEvent;
    onEvent(eventName, payload);
  }
  return remainder;
}

export function askMobileBookAgent(
  request: MobileBookAgentRequest,
  onChunk: (text: string) => void,
  onDone: (conversationId: string, references: MobileBookAgentReference[]) => void,
  onError: (message: string) => void,
): () => void {
  const controller = new AbortController();
  const activeConversationId = request.conversationId || conversationId();
  let settled = false;
  const references = new Map<string, MobileBookAgentReference>();

  void (async () => {
    const token = await mobileAccessToken();
    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Makers-Conversation-Id": activeConversationId,
      },
      body: JSON.stringify({
        message: request.question,
        history: (request.history ?? []).slice(-20).map((message) => ({
          role: message.role,
          content: message.content.replace(/\[cite:[A-Za-z0-9_-]+\]/g, ""),
        })),
        scope: {
          mode: "selected",
          datasetIds: [request.datasetId],
          itemIds: [request.itemId],
          manifestObjects: [request.manifestObject],
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `问答服务返回 HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("问答服务没有返回数据");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneEvent = false;
    const consume = (eventName: string, payload: AgentEvent) => {
      if (eventName === "text_delta" && typeof payload.delta === "string") onChunk(payload.delta);
      if (eventName === "tool_end" && Array.isArray(payload.references)) {
        for (const candidate of payload.references) {
          if (typeof candidate !== "object" || candidate === null) continue;
          const reference = candidate as MobileBookAgentReference;
          const key = `${reference.itemId ?? ""}:${reference.targetId ?? ""}:${reference.anchorId ?? ""}:${reference.fragmentObject ?? ""}`;
          references.set(key, reference);
        }
      }
      if (eventName === "error") throw new Error(typeof payload.message === "string" ? payload.message.replace(/\bAgent\b/gi, "问答服务") : "回答生成失败，请重试");
      if (eventName === "done") doneEvent = true;
    };
    while (!doneEvent) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = parseAgentSseFrames(buffer, consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseAgentSseFrames(`${buffer}\n\n`, consume);
    if (!settled) {
      settled = true;
      onDone(activeConversationId, [...references.values()]);
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    settled = true;
    onError(error instanceof Error ? error.message : String(error));
  });

  return () => controller.abort();
}
