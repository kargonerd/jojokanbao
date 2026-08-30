import { useEffect, useState } from "react";

const READING_LOADING_QUOTES = {
  periodical: [
    { text: "没有调查，没有发言权。", source: "毛泽东《反对本本主义》" },
    { text: "牢骚太盛防肠断，风物长宜放眼量。", source: "毛泽东《七律·和柳亚子先生》" },
    { text: "如果要看前途，一定要看历史。", source: "毛泽东 · 一九六四年七月" },
  ],
  book: [
    { text: "读书是学习，使用也是学习，而且是更重要的学习。", source: "毛泽东《中国革命战争的战略问题》" },
    { text: "学习一定要学到底，学习的最大敌人是不到“底”。", source: "毛泽东 · 一九三九年五月" },
    { text: "虚心使人进步，骄傲使人落后。", source: "毛泽东《中国共产党第八次全国代表大会开幕词》" },
  ],
  times: [
    { text: "你们要关心国家大事。", source: "毛泽东 · 一九六六年八月十日" },
    { text: "问苍茫大地，谁主沉浮？", source: "毛泽东《沁园春·长沙》" },
    { text: "去粗取精，去伪存真，由此及彼，由表及里。", source: "毛泽东《实践论》" },
  ],
} as const;

export type ReadingLoadingKind = keyof typeof READING_LOADING_QUOTES;

export function ReadingLoadingState({
  kind,
  status,
  delayMs = 650,
  fullscreen = false,
  spacingClassName = "px-5 py-8",
  className = "",
}: {
  kind: ReadingLoadingKind;
  status: string;
  delayMs?: number;
  fullscreen?: boolean;
  spacingClassName?: string;
  className?: string;
}) {
  const [showQuote, setShowQuote] = useState(delayMs === 0);
  const [quote] = useState(() => {
    const quotes = READING_LOADING_QUOTES[kind];
    return quotes[Math.floor(Math.random() * quotes.length)]!;
  });

  useEffect(() => {
    if (delayMs === 0) return;
    const timer = window.setTimeout(() => setShowQuote(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);

  return (
    <section
      role="status"
      aria-live="polite"
      className={fullscreen
        ? `fixed inset-0 z-50 flex items-center justify-center bg-paper/90 px-6 text-left ${className}`
        : `${spacingClassName} text-left ${className}`}
    >
      <div className={fullscreen ? "w-full max-w-sm" : ""}>
        <p className="m-0 flex items-center gap-2 font-sans text-[11px] font-bold tracking-[0.08em] text-muted">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-red motion-safe:animate-pulse" />
          {status}
        </p>
        {showQuote ? (
          <blockquote className="mb-0 mt-4 border-l border-rule pl-3 text-muted">
            <p className="m-0 text-[12px] font-normal leading-6">“{quote.text}”</p>
            <footer className="mt-1 font-sans text-[9px] tracking-[0.04em] opacity-70">——{quote.source}</footer>
          </blockquote>
        ) : null}
      </div>
    </section>
  );
}
