import { type FormEvent, useEffect, useRef, useState } from "react";
import { askStream } from "../api";
import type { RagMessage } from "../types";
import { formatChatMarkdown } from "../utils/markdown";
import { ReferenceButtons } from "./ReferenceButtons";

interface BookAiPanelProps {
  bookTitle: string;
  datasetId: string;
  itemId: string;
  manifestObject: string;
  initialQuestion?: string;
  initialAnswer?: string;
  explanationQuote?: string;
  panelClass: string;
  onClose: () => void;
  onExplanationComplete?: (quote: string, answer: string) => void;
}

export function BookAiPanel({ bookTitle, datasetId, itemId, manifestObject, initialQuestion, initialAnswer, explanationQuote, panelClass, onClose, onExplanationComplete }: BookAiPanelProps) {
  const [messages, setMessages] = useState<RagMessage[]>(initialAnswer ? [{ role: "assistant", content: initialAnswer }] : []);
  const [input, setInput] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const initialQuestionSentRef = useRef(false);

  useEffect(() => () => cancelRef.current?.(), []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, streamContent, streamStatus]);

  function ask(question: string): void {
    if (!question || streaming) return;
    const nextMessages = [...messages, { role: "user" as const, content: question }];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setStreaming(true);
    setStreamContent("");
    setStreamStatus("正在准备本书检索…");
    let answer = "";
    cancelRef.current = askStream(
      { datasetIds: [datasetId], scopeMode: "selected", itemIds: [itemId], manifestObjects: [manifestObject], question, conversationId, history: messages },
      (chunk) => { answer += chunk; setStreamContent(answer); },
      (references, nextConversationId) => {
        setMessages([...nextMessages, { role: "assistant", content: answer, references }]);
        setConversationId(nextConversationId);
        setStreaming(false);
        setStreamContent("");
        setStreamStatus("");
        if (explanationQuote && answer) onExplanationComplete?.(explanationQuote, answer);
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

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    ask(input.trim());
  }

  useEffect(() => {
    if (!initialQuestion || initialQuestionSentRef.current) return;
    initialQuestionSentRef.current = true;
    ask(initialQuestion);
  // The panel is remounted for each selection-driven explanation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  return <aside aria-label="书内 AI" className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-[-18px_0_50px_rgba(0,0,0,.12)] sm:w-[min(92vw,480px)] ${panelClass}`}>
    <header className="flex items-start justify-between gap-5 border-b border-rule px-6 py-5">
      <div><p className="m-0 font-sans text-[11px] tracking-[.18em] text-red">书内 AI</p><h2 className="mb-0 mt-2 text-lg leading-snug">{bookTitle}</h2></div>
      <button type="button" onClick={onClose} className="border-0 bg-transparent text-2xl text-current cursor-pointer" aria-label="关闭书内 AI">×</button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      {messages.length === 0 && !streaming && <div className="border-l-2 border-red pl-4"><p className="m-0 text-base">针对当前这本书提问</p><p className="mb-0 mt-2 font-sans text-xs leading-6 text-muted">回答会限定在本书范围内；找到原文位置时可在新标签页打开正文。</p></div>}
      {messages.map((message, index) => <article key={index} className={`mb-6 ${message.role === "user" ? "ml-10 border-r-2 border-red pr-4 text-right" : ""}`}>
        {message.role === "user" ? <p className="m-0 whitespace-pre-wrap text-sm leading-7">{message.content}</p> : <>
          <div className="book-ai-answer text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(message.content, message.references) }} />
          <ReferenceButtons content={message.content} references={message.references} />
        </>}
      </article>)}
      {streaming && <article className="mb-6"><div role="status" className="mb-3 flex items-center gap-2 font-sans text-xs text-muted"><span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 bg-red motion-safe:animate-pulse" />{streamStatus || "正在分析问题并选择资料…"}</div>{streamContent ? <div className="book-ai-answer text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(streamContent) }} /> : null}</article>}
      {error && <p role="alert" className="border-l-2 border-red pl-3 font-sans text-xs leading-6 text-red">{error}</p>}
      <div ref={endRef} />
    </div>
    <form onSubmit={submit} className="border-t border-rule p-4">
      <label className="block"><span className="sr-only">向本书提问</span><textarea autoFocus rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="问这本书……" className="book-ai-input block min-h-16 w-full resize-none border-0 border-b border-rule bg-transparent px-0 py-2 font-serif text-sm leading-6 text-current" /></label>
      <div className="mt-3 flex items-center justify-between"><span className="font-sans text-[10px] text-muted">仅检索当前书籍</span><button type="submit" disabled={!input.trim() || streaming} className="border-0 bg-transparent px-0 py-1 font-sans text-xs font-bold text-red cursor-pointer disabled:cursor-default disabled:opacity-35">提问 →</button></div>
    </form>
  </aside>;
}
