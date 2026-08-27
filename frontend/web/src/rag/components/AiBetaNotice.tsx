export function AiBetaBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center border border-red px-1.5 py-0.5 font-sans text-[8px] font-bold uppercase leading-none tracking-[.12em] text-red ${className}`}
    >
      Beta
    </span>
  );
}

export function AiExperimentalNotice({ className = "" }: { className?: string }) {
  return (
    <div
      role="note"
      aria-label="AI 实验功能说明"
      className={`flex items-start gap-2.5 border-l-2 border-red bg-[#f3e9e7] px-3 py-2.5 ${className}`}
    >
      <AiBetaBadge className="mt-0.5" />
      <p className="m-0 font-sans text-[10px] leading-5 text-ink">
        实验功能：AI 生成的回答可能不准确、遗漏或误解原文，请结合引用内容核对后使用。
      </p>
    </div>
  );
}
