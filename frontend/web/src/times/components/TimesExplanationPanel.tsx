import { useEffect, useRef, useState } from "react";
import { MAX_EXPLANATION_QUESTION_LENGTH, type ExplanationConversation } from "@jojo/ui/reader-explanation";
import type { TextAnchor } from "../../annotations/types";
import { renderMarkdown } from "../../rag/utils/markdown";
import type { TimesExplanationMetadata } from "../ai";

type Props = ExplanationConversation<TextAnchor, TimesExplanationMetadata> & {
  onClose(): void;
  onRetry(): void;
  onAsk(question: string): boolean;
  onStop(): void;
};

export function TimesExplanationPanel({ anchor, turns, onClose, onRetry, onAsk, onStop }: Props) {
  const [draft, setDraft] = useState("");
  const panel = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const followAnswer = useRef(true);
  const close = useRef(onClose);
  close.current = onClose;
  const last = turns.at(-1);
  const busy = last?.phase === "pending";
  const metadata = [...turns].reverse().find((turn) => turn.metadata)?.metadata;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { previousFocus?.focus(); };
  }, []);
  useEffect(() => {
    if (scroll.current && followAnswer.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns]);

  function submit() {
    if (!busy && onAsk(draft)) {
      setDraft("");
      followAnswer.current = true;
    }
  }

  return <>
    <button type="button" aria-label="关闭 AI 解释" tabIndex={-1} onClick={onClose} className="fixed inset-0 z-[79] cursor-default border-0 bg-[rgba(25,25,22,.28)]" />
    <aside ref={panel} role="dialog" aria-modal="true" aria-label="AI 解释" tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); close.current(); }
        if (event.key !== "Tab") return;
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href]') ?? []);
        const first = controls[0];
        const end = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); end?.focus(); }
        else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first?.focus(); }
      }}
      className="fixed right-0 top-0 z-[80] flex h-[100dvh] w-full max-w-[440px] flex-col border-l border-rule bg-paper text-ink shadow-[-18px_0_44px_rgba(32,32,32,.18)] outline-none">
      <header className="flex shrink-0 items-center justify-between border-b-[3px] border-double border-rule px-6 py-5">
        <div className="border-l-[3px] border-red pl-3"><h2 className="text-2xl font-black text-red">AI 解释</h2></div>
        <button type="button" onClick={onClose} aria-label="关闭" className="border-0 bg-transparent text-3xl text-ink">×</button>
      </header>
      <div ref={scroll} onScroll={(event) => {
        const element = event.currentTarget;
        followAnswer.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
        <blockquote className="my-6 border-y border-rule bg-[rgba(139,26,26,.035)] px-5 py-4 text-sm leading-7">“{anchor.quote}”</blockquote>
        {turns.map((turn, index) => <section key={index} aria-label={`回答 ${index + 1}`} className={index ? "mt-6 border-t border-rule pt-6" : ""}>
          {turn.question ? <div className="mb-4 border-l-2 border-red bg-red/[0.035] px-4 py-3 text-sm leading-7 whitespace-pre-wrap"><span className="mb-1 block font-sans text-[10px] font-bold text-red">你</span>{turn.question}</div> : null}
          {turn.answer ? <div className="text-[15px] leading-7 [&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-red [&_blockquote]:pl-4 [&_li]:my-2 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-4 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-black [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-5"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.answer.replace(/<!--[^]*$/u, "")) }} /> : null}
          {turn.phase === "pending" ? <div role="status" className="mt-4 flex items-center gap-3 font-sans text-[11px] font-bold text-muted">
            <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin border-2 border-red/20 border-t-red motion-reduce:animate-none" />
            <span>{turn.status}</span>
          </div> : null}
          {turn.error ? <p role="alert" className="mt-4 border-l-2 border-red pl-4 text-sm leading-7 text-red">{turn.error}</p> : null}
          {turn.phase === "stopped" ? <p className="mt-3 font-sans text-xs text-muted">已停止生成</p> : null}
          {index === turns.length - 1 && ["error", "stopped"].includes(turn.phase) ? <button type="button" onClick={onRetry} className="mt-3 border-b border-red font-sans text-xs font-bold text-red">{turn.question ? "重试回答" : "重新解释"}</button> : null}
        </section>)}
      </div>
      <footer className="shrink-0 border-t border-rule bg-paper px-6 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
        <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label htmlFor="times-explanation-question" className="sr-only">继续提问</label>
          <textarea id="times-explanation-question" value={draft} onChange={(event) => setDraft(event.target.value)}
            placeholder="继续提问…" rows={2} maxLength={MAX_EXPLANATION_QUESTION_LENGTH}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault(); submit();
              }
            }}
            className="block max-h-36 w-full resize-y border-0 border-b border-rule bg-transparent py-2 text-sm leading-6 text-ink outline-none placeholder:text-muted focus:border-red" />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="font-sans text-[9px] text-muted">{metadata?.model || ""}</span>
            {busy ? <button type="button" onClick={onStop} className="border border-red px-4 py-2 font-sans text-xs font-bold text-red">停止生成</button>
              : <button type="submit" disabled={!draft.trim()} className="border border-red bg-red px-4 py-2 font-sans text-xs font-bold text-paper disabled:cursor-default disabled:opacity-35">发送 →</button>}
          </div>
        </form>
      </footer>
    </aside>
  </>;
}
