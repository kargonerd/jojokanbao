const AGENT_URL = process.env.EXPO_PUBLIC_AGENT_API_URL?.trim()
  || "https://agent-global.jojokanbao.cn/rag";

export interface MobileBookAgentRequest {
  datasetId: string;
  itemId: string;
  manifestObject: string;
  question: string;
  conversationId?: string;
}

export interface MobileBookAgentReference {
  datasetId?: string;
  itemId?: string;
  targetId?: string;
  anchorId?: string;
  title?: string;
  excerpt?: string;
  fragmentObject?: string;
}

export interface MobileBookAgentConversationScope {
  mode?: "all" | "selected";
  datasetIds?: string[];
  itemIds?: string[];
  manifestObjects?: string[];
}

export interface MobileBookAgentConversation {
  id: string;
  title: string;
  createdAt?: number;
  lastMessageAt?: number;
  messageCount: number;
  scope?: MobileBookAgentConversationScope;
}

export interface MobileBookAgentMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  references?: MobileBookAgentReference[];
}

export interface MobileBookAgentConversationDetail {
  conversation: MobileBookAgentConversation;
  messages: MobileBookAgentMessage[];
}

type AgentEvent = Record<string, unknown>;

function conversationId(): string {
  return `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 36);
}

function conversationBaseUrl(): string {
  return new URL("/gateway/conversations", AGENT_URL).toString().replace(/\/$/, "");
}

async function mobileAccessToken(): Promise<string> {
  const { mobileAuthClient } = await import("../account/auth");
  const { data, error } = await mobileAuthClient.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("请先在「我」中登录后使用书内 AI");
  return token;
}

async function conversationRequest<T>(path = "", init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await mobileAccessToken()}`);
  headers.set("Accept", "application/json");
  const response = await fetch(`${conversationBaseUrl()}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `历史记录返回 HTTP ${response.status}`);
  }
  return response.status === 204
    ? undefined as T
    : response.json() as Promise<T>;
}

export async function listMobileBookAgentConversations(
  itemId: string,
): Promise<MobileBookAgentConversation[]> {
  const payload = await conversationRequest<{
    conversations?: MobileBookAgentConversation[];
  }>("?limit=100");
  return (Array.isArray(payload.conversations) ? payload.conversations : [])
    .filter((conversation) => conversation.scope?.itemIds?.includes(itemId));
}

export function getMobileBookAgentConversation(
  conversationId: string,
): Promise<MobileBookAgentConversationDetail> {
  return conversationRequest(`/${encodeURIComponent(conversationId)}`);
}

export async function deleteMobileBookAgentConversation(
  conversationId: string,
): Promise<void> {
  await conversationRequest<void>(`/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  });
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
