import {
  mobileAccessToken,
  parseAgentSseFrames,
  type MobileBookAgentMessage,
  type MobileBookAgentReference,
} from "./bookAgent";

const AGENT_URL = process.env.EXPO_PUBLIC_AGENT_API_URL?.trim()
  || "https://agent-global.jojokanbao.cn/rag";
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARACTERS = 100_000;

export interface MobileLibraryAgentRequest {
  question: string;
  datasetIds: string[];
  scopeMode: "all" | "selected";
  conversationId?: string;
  history?: MobileBookAgentMessage[];
  itemIds?: string[];
  manifestObjects?: string[];
}

export interface MobileAgentActivity {
  phase: "connecting" | "thinking" | "searching" | "reading" | "writing";
  message: string;
}

interface MobileLibraryAgentCallbacks {
  onChunk(text: string): void;
  onDone(conversationId: string, references: MobileBookAgentReference[]): void;
  onError(message: string): void;
  onActivity?(activity: MobileAgentActivity): void;
}

type AgentEvent = Record<string, unknown>;

function newConversationId(): string {
  return `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.slice(0, 36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortArgument(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = typeof args.query === "string"
    ? args.query
    : typeof args.titleQuery === "string"
      ? args.titleQuery
      : "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 32) : undefined;
}

export function mobileAgentToolActivity(name: unknown, args?: unknown, isError = false): MobileAgentActivity {
  if (isError) return { phase: "thinking", message: "这一步没有取得结果，正在调整检索方式…" };
  const query = shortArgument(args);
  const suffix = query ? `：“${query}”` : "…";
  switch (name) {
    case "read_focus_context":
      return { phase: "reading", message: "正在读取相关上下文…" };
    case "list_library_books":
      return { phase: "searching", message: `正在筛选可能相关的书籍${suffix}` };
    case "list_book_items":
      return { phase: "searching", message: "正在查看候选书籍及分卷…" };
    case "search_selected_item":
      return { phase: "searching", message: `正在当前书籍中检索原文${suffix}` };
    case "search_content":
      return { phase: "searching", message: `正在馆藏中检索原文${suffix}` };
    case "inspect_item":
      return { phase: "reading", message: "正在读取书籍概况…" };
    case "list_item_toc":
      return { phase: "reading", message: "正在查看目录并选择相关章节…" };
    case "read_fragment":
    case "scan_full_item":
      return { phase: "reading", message: "正在读取命中的相关章节…" };
    default:
      return { phase: "thinking", message: "正在核对馆藏资料…" };
  }
}

export function boundedMobileAgentHistory(
  messages: readonly MobileBookAgentMessage[],
): Array<Pick<MobileBookAgentMessage, "role" | "content">> {
  let remainingCharacters = MAX_HISTORY_CHARACTERS;
  const newestFirst: Array<Pick<MobileBookAgentMessage, "role" | "content">> = [];
  for (const message of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const content = message.content.replace(/\[cite:[A-Za-z0-9_-]+\]/g, "").trim();
    if (!content) continue;
    const messageLimit = message.role === "user" ? 10_000 : 20_000;
    const bounded = content.slice(0, Math.min(messageLimit, remainingCharacters));
    if (!bounded) break;
    newestFirst.push({ role: message.role, content: bounded });
    remainingCharacters -= bounded.length;
    if (!remainingCharacters) break;
  }
  return newestFirst.reverse();
}

export function askMobileLibraryAgent(
  request: MobileLibraryAgentRequest,
  callbacks: MobileLibraryAgentCallbacks,
): () => void {
  const controller = new AbortController();
  const activeConversationId = request.conversationId || newConversationId();
  let settled = false;
  let answer = "";
  let receivedDone = false;
  let writingStarted = false;
  const references = new Map<string, MobileBookAgentReference>();

  const finish = () => {
    if (settled) return;
    settled = true;
    const allReferences = [...references.values()];
    const citationIds = [...answer.matchAll(/\[cite:([A-Za-z0-9_-]+)\]/g)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value));
    if (!citationIds.length) {
      callbacks.onDone(activeConversationId, allReferences);
      return;
    }
    const byCitationId = new Map(allReferences.flatMap((reference) => (
      reference.citationId ? [[reference.citationId, reference] as const] : []
    )));
    callbacks.onDone(
      activeConversationId,
      [...new Set(citationIds)].flatMap((citationId) => {
        const reference = byCitationId.get(citationId);
        return reference ? [reference] : [];
      }),
    );
  };

  void (async () => {
    callbacks.onActivity?.({ phase: "connecting", message: "正在确认登录状态…" });
    const token = await mobileAccessToken();
    callbacks.onActivity?.({ phase: "connecting", message: "正在连接馆藏…" });
    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Makers-Conversation-Id": activeConversationId,
      },
      body: JSON.stringify({
        message: request.question,
        history: boundedMobileAgentHistory(request.history ?? []),
        scope: {
          mode: request.scopeMode,
          datasetIds: request.datasetIds,
          itemIds: request.itemIds ?? [],
          manifestObjects: request.manifestObjects ?? [],
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `问答服务返回 HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("问答服务没有返回数据");

    const consume = (eventName: string, event: AgentEvent) => {
      if (eventName === "status") {
        callbacks.onActivity?.({ phase: "thinking", message: "正在分析问题并选择资料…" });
      } else if (eventName === "tool_start") {
        callbacks.onActivity?.(mobileAgentToolActivity(event.name, event.args));
      } else if (eventName === "tool_end") {
        if (Array.isArray(event.references)) {
          for (const candidate of event.references) {
            if (!isRecord(candidate)) continue;
            const reference = candidate as MobileBookAgentReference;
            const key = [
              reference.datasetId ?? "",
              reference.itemId ?? "",
              reference.targetId ?? "",
              reference.anchorId ?? "",
            ].join("\0");
            references.set(key, { ...references.get(key), ...reference });
          }
        }
        callbacks.onActivity?.(event.isError === true
          ? mobileAgentToolActivity(event.name, undefined, true)
          : { phase: "thinking", message: "已取得一批资料，正在判断是否继续查找…" });
      } else if (eventName === "turn_end") {
        callbacks.onActivity?.({ phase: "thinking", message: "正在核对证据与引用位置…" });
      } else if (eventName === "text_delta" && typeof event.delta === "string") {
        if (!writingStarted) {
          writingStarted = true;
          callbacks.onActivity?.({ phase: "writing", message: "正在根据原文组织回答…" });
        }
        answer += event.delta;
        callbacks.onChunk(event.delta);
      } else if (eventName === "error") {
        throw new Error(typeof event.message === "string" ? event.message : "回答生成失败，请重试");
      } else if (eventName === "done") {
        receivedDone = true;
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!receivedDone) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = parseAgentSseFrames(buffer, consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseAgentSseFrames(`${buffer}\n\n`, consume);
    if (!receivedDone) throw new Error("回答连接意外中断，请重试");
    finish();
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    settled = true;
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError(message.replace(/\bAgent\b/gi, "问答服务"));
  });

  return () => controller.abort();
}
