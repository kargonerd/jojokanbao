import { type FormEvent, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { IoCheckmarkOutline, IoCopyOutline, IoRefreshOutline } from "react-icons/io5";
import { askStream } from "../api";
import type {
  RagAnswerMetadata,
  RagFocusContext,
  RagMessage,
  RagReference,
} from "../types";
import { formatChatMarkdown, formatChatPlainText } from "../utils/markdown";
import { AiExperimentalNotice } from "./AiBetaNotice";
import { ReferenceButtons } from "./ReferenceButtons";

interface BookAiPanelProps {
  bookTitle: string;
  datasetId: string;
  itemId: string;
  manifestObject: string;
  initialQuestion?: string;
  initialAnswer?: string;
  initialReferences?: RagReference[];
  preparing?: boolean;
  explanationQuote?: string;
  focus?: RagFocusContext;
  panelClass: string;
  embedded?: boolean;
  onClose: () => void;
  onExplanationComplete?: (quote: string, answer: string, references?: RagReference[], metadata?: RagAnswerMetadata) => void;
}

export function BookAiPanel({ bookTitle, datasetId, itemId, manifestObject, initialQuestion, initialAnswer, initialReferences, preparing = false, explanationQuote, focus, panelClass, embedded = false, onClose, onExplanationComplete }: BookAiPanelProps) {
  const location = useLocation();
  const [messages, setMessages] = useState<RagMessage[]>(initialAnswer ? [{ role: "assistant", content: initialAnswer, references: initialReferences }] : []);
  const [input, setInput] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [copyNotice, setCopyNotice] = useState<{ index: number; label: string }>();
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const initialQuestionSentRef = useRef(false);

  useEffect(() => () => {
    cancelRef.current?.();
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, streamContent, streamStatus]);

  function runAsk(question: string, history: RagMessage[], nextMessages: RagMessage[]): void {
    setMessages(nextMessages);
    setInput("");
    setError("");
    setStreaming(true);
    setStreamContent("");
    setStreamStatus("正在准备本书检索…");
    setCopyNotice(undefined);
    let answer = "";
    cancelRef.current = askStream(
      { datasetIds: [datasetId], scopeMode: "selected", itemIds: [itemId], manifestObjects: [manifestObject], question, conversationId, history, focus },
      (chunk) => { answer += chunk; setStreamContent(answer); },
      (references, nextConversationId, metadata) => {
        setMessages([...nextMessages, { role: "assistant", content: answer, references }]);
        setConversationId(nextConversationId);
        setStreaming(false);
        setStreamContent("");
        setStreamStatus("");
        if (explanationQuote && initialQuestion && question === initialQuestion && answer) {
          onExplanationComplete?.(explanationQuote, answer, references, metadata);
        }
      },
      (message) => {
        setError(message);
        setStreaming(false);
        setStreamContent("");
        setStreamStatus("");
      },
      (activity) => setStreamStatus(activity.message),
    );
  }

  function ask(question: string): void {
    if (!question || streaming) return;
    runAsk(question, messages, [...messages, { role: "user", content: question }]);
  }

  function regenerate(): void {
    if (streaming) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    let userIndex = messages.length - 2;
    while (userIndex >= 0 && messages[userIndex]?.role !== "user") userIndex -= 1;
    const question = (userIndex >= 0 ? messages[userIndex]?.content : undefined) || initialQuestion;
    if (!question) return;
    runAsk(
      question,
      userIndex >= 0 ? messages.slice(0, userIndex) : [],
      userIndex >= 0 ? messages.slice(0, userIndex + 1) : [{ role: "user", content: question }],
    );
  }

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    ask(input.trim());
  }

  useEffect(() => {
    if (!initialQuestion || initialQuestionSentRef.current) return;
    const timer = window.setTimeout(() => {
      if (initialQuestionSentRef.current) return;
      initialQuestionSentRef.current = true;
      ask(initialQuestion);
    }, 0);
    return () => window.clearTimeout(timer);
  // The panel is remounted for each selection-driven explanation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  async function copyAnswer(index: number, content: string, references?: RagReference[]): Promise<void> {
    const text = formatChatPlainText(content, references);
    if (!text) return;
    const copied = await writeClipboard(text);
    setCopyNotice({ index, label: copied ? "已复制" : "复制失败" });
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyNotice(undefined), 1600);
  }

  return <aside aria-label="书内 AI" className={embedded ? "flex min-h-0 flex-1 flex-col" : `fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-[-18px_0_50px_rgba(0,0,0,.12)] sm:w-[min(92vw,480px)] ${panelClass}`}>
    {!embedded && <header className="flex items-start justify-between gap-5 border-b border-rule px-6 py-5">
      <div><p className="m-0 font-sans text-[11px] tracking-[.18em] text-red"><span className="relative inline-block">书内 AI<span className="absolute -right-5 -top-1 font-sans text-[6px] font-bold tracking-normal">Beta</span></span></p><h2 className="mb-0 mt-2 text-lg leading-snug">{bookTitle}</h2></div>
      <button type="button" onClick={onClose} className="border-0 bg-transparent text-2xl text-current cursor-pointer" aria-label="关闭书内 AI">×</button>
    </header>}
    <AiExperimentalNotice className="mx-6 mt-5 shrink-0" />
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {preparing && messages.length === 0 && !streaming && <div role="status" className="flex items-center gap-2 font-sans text-xs text-muted"><span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 bg-red motion-safe:animate-pulse" />正在查找已有解释…</div>}
      {!preparing && messages.length === 0 && !streaming && <div className="border-l-2 border-red pl-4"><p className="m-0 text-base">针对当前这本书提问</p><p className="mb-0 mt-2 font-sans text-xs leading-6 text-muted">回答会限定在本书范围内；找到原文位置时可在新标签页打开正文。</p></div>}
      {messages.map((message, index) => {
        const copied = copyNotice?.index === index && copyNotice.label === "已复制";
        const canRegenerate = message.role === "assistant"
          && index === messages.length - 1
          && Boolean(initialQuestion || messages.slice(0, index).some((item) => item.role === "user"));
        const actionClass = "flex h-7 w-7 shrink-0 items-center justify-center border border-rule bg-transparent text-current cursor-pointer hover:border-red hover:text-red focus-visible:outline-2 focus-visible:outline-red disabled:cursor-default disabled:opacity-35";
        return <article key={index} className={`mb-6 ${message.role === "user" ? "ml-10 border-r-2 border-red pr-4 text-right" : ""}`}>
          {message.role === "user" ? <p className="m-0 whitespace-pre-wrap text-sm leading-7">{message.content}</p> : <>
            <div className="book-ai-answer text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(message.content, message.references) }} />
            <div className="mt-3 flex items-center gap-2 font-sans text-[11px]">
              <button
                type="button"
                onClick={() => void copyAnswer(index, message.content, message.references)}
                aria-label="复制回答文本"
                title="复制"
                className={actionClass}
              >
                {copied ? <IoCheckmarkOutline aria-hidden="true" className="h-3.5 w-3.5" /> : <IoCopyOutline aria-hidden="true" className="h-3.5 w-3.5" />}
              </button>
              {canRegenerate && <button
                type="button"
                onClick={regenerate}
                aria-label="重新生成回答"
                title="重新生成"
                disabled={streaming}
                className={actionClass}
              >
                <IoRefreshOutline aria-hidden="true" className="h-3.5 w-3.5" />
              </button>}
              <span role="status" className="sr-only">{copyNotice?.index === index ? copyNotice.label : ""}</span>
            </div>
            <ReferenceButtons
              content={message.content}
              references={message.references}
              returnTo={`${location.pathname}${location.search}`}
            />
          </>}
        </article>;
      })}
      {streaming && <article className="mb-6"><div role="status" className="mb-3 flex items-center gap-2 font-sans text-xs text-muted"><span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 bg-red motion-safe:animate-pulse" />{streamStatus || "正在分析问题并选择资料…"}</div>{streamContent ? <div className="book-ai-answer text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(streamContent) }} /> : null}</article>}
      {error && <p role="alert" className="border-l-2 border-red pl-3 font-sans text-xs leading-6 text-red">{error}</p>}
      <div ref={endRef} />
    </div>
    <form onSubmit={submit} className="border-t border-rule p-4">
      <label className="block"><span className="sr-only">向本书提问</span><textarea autoFocus={!embedded && !preparing} disabled={preparing} rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={preparing ? "正在准备这段文字的解释……" : "问这本书……"} className="book-ai-input block min-h-16 w-full resize-none border-0 border-b border-rule bg-transparent px-0 py-2 font-serif text-sm leading-6 text-current disabled:opacity-50" /></label>
      <div className="mt-3 flex items-center justify-between"><span className="font-sans text-[10px] text-muted">仅检索当前书籍</span><button type="submit" disabled={preparing || !input.trim() || streaming} className="border-0 bg-transparent px-0 py-1 font-sans text-xs font-bold text-red cursor-pointer disabled:cursor-default disabled:opacity-35">提问 →</button></div>
    </form>
  </aside>;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to a selection copy for browsers that block the Clipboard API.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
