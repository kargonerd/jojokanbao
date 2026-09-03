import type { TextAnchor } from "../../annotations/types";
import { renderMarkdown } from "../../rag/utils/markdown";
import type { TimesExplanationMetadata } from "../ai";

export function TimesExplanationPanel({
  anchor,
  answer,
  status,
  error,
  metadata,
  onClose,
}: {
  anchor: TextAnchor;
  answer: string;
  status: string;
  error: string;
  metadata?: TimesExplanationMetadata;
  onClose(): void;
}) {
  return (
    <>
      <button type="button" aria-label="关闭 AI 解释" onClick={onClose} className="fixed inset-0 z-[79] cursor-default border-0 bg-[rgba(25,25,22,.28)]" />
      <aside aria-label="AI 解释" className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[440px] flex-col border-l border-rule bg-paper text-ink shadow-[-18px_0_44px_rgba(32,32,32,.18)]">
        <header className="flex items-center justify-between border-b-[3px] border-double border-rule px-6 py-5">
          <div className="border-l-[3px] border-red pl-3"><h2 className="text-2xl font-black text-red">AI 解释</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭" className="border-0 bg-transparent text-3xl text-ink">×</button>
        </header>
        <blockquote className="m-6 border-y border-rule bg-[rgba(139,26,26,.035)] px-5 py-4 text-sm leading-7">“{anchor.quote}”</blockquote>
        <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          {status ? <p className="mb-4 font-sans text-[11px] font-bold text-muted">{status}</p> : null}
          {error ? <p role="alert" className="border-l-2 border-red pl-4 text-sm leading-7 text-red">{error}</p> : null}
          {answer ? (
            <div
              className="text-[15px] leading-7 [&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-red [&_blockquote]:pl-4 [&_li]:my-2 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-4 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-black [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }}
            />
          ) : null}
        </div>
        {metadata ? <footer className="border-t border-rule px-6 py-3 font-sans text-[9px] text-muted">{metadata.imageCount ? `已结合 ${metadata.imageCount} 张随文图片` : "本次仅使用文字上下文"}{metadata.model ? ` · ${metadata.model}` : ""}</footer> : null}
      </aside>
    </>
  );
}
