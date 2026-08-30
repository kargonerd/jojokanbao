import { useEffect, useRef, useState } from "react";
import type { TimesForeignContentLanguage } from "../../times/language";
import { useTimesPreferencesStore } from "../../times/preferencesStore";

const OPTIONS: Array<{ value: TimesForeignContentLanguage; label: string }> = [
  { value: "zh-CN", label: "中文译文" },
  { value: "original", label: "原文" },
];

export function TimesLanguagePreference() {
  const language = useTimesPreferencesStore((state) => state.foreignContentLanguage);
  const setLanguage = useTimesPreferencesStore((state) => state.setForeignContentLanguage);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = OPTIONS.find((option) => option.value === language) ?? OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function choose(value: TimesForeignContentLanguage) {
    setLanguage(value);
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div>
        <h3 className="m-0 font-serif text-base font-black text-ink">时事外文内容</h3>
        <p className="mb-0 mt-1 text-xs font-bold leading-6 text-muted">
          有中文译文时优先显示，否则显示出版方原文。
        </p>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 font-sans text-xs font-bold text-muted sm:justify-start">
        <span id="times-language-label">默认语言</span>
        <div ref={menuRef} className="relative min-w-36">
          <button
            type="button"
            aria-label={`时事外文内容默认语言：${selected.label}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-10 w-full items-center justify-between gap-5 border border-rule-dark bg-paper px-3 text-left font-sans text-sm font-black text-ink transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-red hover:text-red hover:shadow-[3px_3px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red"
          >
            <span id="times-language-value">{selected.label}</span>
            <span aria-hidden="true" className={`text-[10px] text-red transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
          </button>
          {open ? (
            <div
              role="listbox"
              aria-label="时事外文内容默认语言"
              className="absolute right-0 top-[calc(100%+4px)] z-30 w-full border border-rule-dark bg-paper p-1 shadow-[4px_4px_0_rgba(139,26,26,.14)]"
            >
              {OPTIONS.map((option) => {
                const active = option.value === language;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => choose(option.value)}
                    className={`flex min-h-10 w-full items-center justify-between border-l-2 px-3 text-left font-sans text-sm font-bold ${active ? "border-red bg-red/[0.06] text-red" : "border-transparent text-ink hover:bg-[var(--app-canvas)] hover:text-red"}`}
                  >
                    <span>{option.label}</span>
                    {active ? <span aria-hidden="true" className="text-red">✓</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
