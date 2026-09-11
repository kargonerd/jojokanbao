import { createStore } from "zustand/vanilla";

export const MAX_EXPLANATION_QUESTION_LENGTH = 2_000;

export interface ExplanationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ExplanationRequest {
  question?: string;
  history?: ExplanationMessage[];
  conversationId?: string;
}

export interface ExplanationTurn<Metadata> {
  question: string;
  answer: string;
  phase: "pending" | "complete" | "error" | "stopped";
  status: string;
  error: string;
  metadata?: Metadata;
}

export interface ExplanationConversation<Anchor, Metadata> {
  anchor: Anchor;
  conversationId: string;
  turns: ExplanationTurn<Metadata>[];
}

export interface ExplanationCallbacks<Metadata> {
  onStatus(status: string): void;
  onChunk(text: string): void;
  onDone(metadata: Metadata, answer: string): void;
  onError(message: string): void;
}

/** Keep the latest question and reading context even when older turns age out. */
export function readerExplanationRequest(context: string, request: ExplanationRequest = {}) {
  const question = request.question?.trim();
  if (question && question.length > MAX_EXPLANATION_QUESTION_LENGTH) throw new Error("问题最多 2000 字");
  const message = question
    ? `${context.slice(0, 7_500)}\n\n用户追问（请结合之前的问答直接回答，不要重复最初的解释）：\n${question}`
    : context;
  const history: ExplanationMessage[] = [];
  let characters = 0;
  // Match the gateway's 20-message / 100,000-character history budget.
  for (const item of [...(request.history ?? [])].slice(-20).reverse()) {
    const content = item.content.trim().slice(0, item.role === "user" ? 10_000 : 20_000);
    if (!content) continue;
    if (characters + content.length > 90_000) break;
    history.unshift({ role: item.role, content });
    characters += content.length;
  }
  // Do not start retained history with an orphaned assistant answer.
  if (history[0]?.role === "assistant") history.shift();
  return { message, ...(history.length ? { history } : {}) };
}

/** Shared lifecycle for Web/Desktop and native reading explanations. */
export function createReaderExplanation<Anchor, Metadata>(
  transport: (anchor: Anchor, callbacks: ExplanationCallbacks<Metadata>, request: ExplanationRequest) => () => void,
) {
  type Conversation = ExplanationConversation<Anchor, Metadata> | null;
  const state = createStore<Conversation>(() => null);
  let cancel: (() => void) | undefined;
  let generation = 0;
  function publish(next: Conversation) {
    state.setState(next, true);
  }
  function abort() {
    generation += 1;
    const active = cancel;
    cancel = undefined;
    active?.();
  }
  function close() { abort(); publish(null); }

  function run(next: NonNullable<Conversation>) {
    abort();
    const version = generation;
    const turn = next.turns.at(-1)!;
    const history = next.turns.slice(0, -1).filter((item) => item.phase === "complete").flatMap((item): ExplanationMessage[] => [
      { role: "user", content: item.question || "请解释选中文字。" },
      { role: "assistant", content: item.answer },
    ]);
    publish(next);
    let settled = false;
    function update(patch: Partial<ExplanationTurn<Metadata>>) {
      const current = state.getState();
      if (settled || version !== generation || !current) return;
      const turns = [...current.turns];
      turns[turns.length - 1] = { ...turns.at(-1)!, ...patch };
      publish({ ...current, turns });
    }
    const callbacks: ExplanationCallbacks<Metadata> = {
      onStatus: (status) => update({ status }),
      onChunk: (text) => update({ answer: (state.getState()?.turns.at(-1)?.answer ?? "") + text }),
      onDone: (metadata, answer) => { update({ answer, metadata, phase: "complete", status: "" }); settled = true; },
      onError: (error) => { update({ error, phase: "error", status: "" }); settled = true; },
    };
    try {
      cancel = transport(next.anchor, callbacks, {
        ...(turn.question ? { question: turn.question } : {}), history, conversationId: next.conversationId,
      });
    } catch (error) {
      callbacks.onError(error instanceof Error ? error.message : "AI 解释失败");
    }
  }

  const pendingTurn = (question = ""): ExplanationTurn<Metadata> => ({ question, answer: "", phase: "pending", status: "正在准备…", error: "" });
  function start(anchor: Anchor) {
    run({ anchor, conversationId: `times_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`, turns: [pendingTurn()] });
  }
  function ask(value: string): boolean {
    const current = state.getState();
    const question = value.trim();
    if (!current || current.turns.at(-1)?.phase === "pending" || !question || question.length > MAX_EXPLANATION_QUESTION_LENGTH) return false;
    run({ ...current, turns: [...current.turns, pendingTurn(question)] });
    return true;
  }
  function retry() {
    const previous = state.getState();
    const last = previous?.turns.at(-1);
    if (!previous || !last || !["error", "stopped"].includes(last.phase)) return;
    run({ ...previous, turns: [...previous.turns.slice(0, -1), pendingTurn(last.question)] });
  }
  function stop() {
    const current = state.getState();
    if (!current || current.turns.at(-1)?.phase !== "pending") return;
    abort();
    const turns = [...current.turns];
    turns[turns.length - 1] = { ...turns.at(-1)!, phase: "stopped", status: "" };
    publish({ ...current, turns });
  }
  return { getSnapshot: state.getState, subscribe: state.subscribe, start, ask, retry, stop, close };
}
