import type { TimesForeignContentLanguage } from "../language";
import { useTimesPreferencesStore } from "../preferencesStore";

const OPTIONS: Array<{ value: TimesForeignContentLanguage; label: string }> = [
  { value: "zh-CN", label: "中文译文" },
  { value: "original", label: "原文" },
];

export function TimesLanguageSetting({ className = "" }: { className?: string }) {
  const language = useTimesPreferencesStore((state) => state.foreignContentLanguage);
  const setLanguage = useTimesPreferencesStore((state) => state.setForeignContentLanguage);

  return (
    <fieldset className={`m-0 border-0 p-0 font-sans ${className}`}>
      <legend className="px-0 pb-2 text-[10px] font-black tracking-[0.16em] text-muted">外文内容语言</legend>
      <div className="grid grid-cols-2 border border-rule-dark" role="radiogroup" aria-label="外文内容语言">
        {OPTIONS.map((option) => {
          const active = language === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setLanguage(option.value)}
              className={`min-h-9 px-2 text-xs font-bold ${option.value === "original" ? "border-l border-rule-dark" : ""} ${active ? "bg-red text-paper" : "bg-paper text-ink hover:text-red"}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mb-0 mt-2 text-[9px] leading-4 text-muted">
        {language === "zh-CN" ? "有译文时优先显示，并标注 AI 翻译。" : "保留出版方的标题、摘要和正文。"}
      </p>
    </fieldset>
  );
}
