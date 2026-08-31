import { useEffect, useRef, useState } from "react";
import { DatePicker } from "./DatePicker";

export interface DateRangeValue {
  startDate: string;
  endDate: string;
}

export interface DateRangeShortcut extends DateRangeValue {
  value: string;
  label: string;
  title?: string;
}

interface DateRangePickerProps extends DateRangeValue {
  onChange: (value: DateRangeValue) => void;
  shortcuts?: readonly DateRangeShortcut[];
  disabledStartDate?: (dateStr: string) => boolean;
  disabledEndDate?: (dateStr: string) => boolean;
  editable?: boolean;
  startLabel?: string;
  endLabel?: string;
  shortcutLabel?: string;
  placeholder?: string;
  clearLabel?: string;
  applyLabel?: string;
  ariaLabel?: string;
  className?: string;
  widthClassName?: string;
}

function formatDate(value: string): string {
  return value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

export function DateRangePicker({
  startDate,
  endDate,
  onChange,
  shortcuts = [],
  disabledStartDate,
  disabledEndDate,
  editable = false,
  startLabel = "开始日期",
  endLabel = "结束日期",
  shortcutLabel = "快速选择",
  placeholder = "选择日期范围",
  clearLabel = "清除日期",
  applyLabel = "应用",
  ariaLabel = "日期范围",
  className = "",
  widthClassName = "w-[292px] sm:w-[350px]",
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftStartDate, setDraftStartDate] = useState(startDate);
  const [draftEndDate, setDraftEndDate] = useState(endDate);
  const ref = useRef<HTMLDivElement>(null);
  const selectedShortcut = shortcuts.find((shortcut) => shortcut.startDate === startDate && shortcut.endDate === endDate);
  const hasValue = Boolean(startDate && endDate);
  const displayValue = hasValue ? `${formatDate(startDate)} — ${formatDate(endDate)}` : placeholder;
  const rangeInvalid = Boolean(draftStartDate && draftEndDate && draftStartDate > draftEndDate);
  const canApply = Boolean(draftStartDate && draftEndDate && draftStartDate <= draftEndDate);

  useEffect(() => {
    setDraftStartDate(startDate);
    setDraftEndDate(endDate);
  }, [startDate, endDate]);

  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const openPanel = () => {
    setDraftStartDate(startDate);
    setDraftEndDate(endDate);
    setOpen((current) => !current);
  };

  const clearRange = () => {
    setDraftStartDate("");
    setDraftEndDate("");
    setOpen(false);
    onChange({ startDate: "", endDate: "" });
  };

  const applyRange = () => {
    if (!canApply) return;
    setOpen(false);
    onChange({ startDate: draftStartDate, endDate: draftEndDate });
  };

  const selectShortcut = (shortcut: DateRangeShortcut) => {
    setDraftStartDate(shortcut.startDate);
    setDraftEndDate(shortcut.endDate);
    setOpen(false);
    onChange({ startDate: shortcut.startDate, endDate: shortcut.endDate });
  };

  return (
    <div ref={ref} className={`relative inline-block ${widthClassName} ${className}`}>
      <div className="flex h-9 w-full border border-rule-dark bg-paper transition-colors focus-within:border-red">
        <button
          type="button"
          aria-label={`${ariaLabel}：${displayValue}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openPanel}
          className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-3 text-left text-xs text-ink"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M2.5 4.5h11v9h-11zM5 2.5v4m6-4v4M2.5 7h11" />
          </svg>
          <span className={`truncate font-serif ${hasValue ? "text-ink" : "text-muted"}`}>{displayValue}</span>
        </button>
        {hasValue && (
          <button
            type="button"
            aria-label={clearLabel}
            title={clearLabel}
            onClick={clearRange}
            className="flex w-8 shrink-0 items-center justify-center border-0 border-l border-rule bg-paper text-base text-muted transition-colors hover:text-red"
          >
            ×
          </button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="选择日期范围"
          className="fixed left-3 right-3 top-[96px] z-[100] border-2 border-red bg-paper shadow-[6px_6px_0_rgba(139,26,26,.14)] sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:w-[660px]"
        >
          <div className="flex flex-col sm:flex-row">
            {shortcuts.length > 0 && (
              <div className="border-b border-rule p-3 sm:w-[184px] sm:shrink-0 sm:border-b-0 sm:border-r">
                <p className="mb-2 text-[11px] font-bold tracking-[.16em] text-muted">{shortcutLabel}</p>
                <div className="flex flex-wrap gap-1.5 sm:block sm:space-y-1">
                  {shortcuts.map((shortcut) => {
                    const selected = selectedShortcut?.value === shortcut.value;
                    return (
                      <button
                        key={shortcut.value}
                        type="button"
                        aria-pressed={selected}
                        title={shortcut.title ?? `${formatDate(shortcut.startDate)} 至 ${formatDate(shortcut.endDate)}`}
                        onClick={() => selectShortcut(shortcut)}
                        className={`border px-2.5 py-2 text-left text-xs font-bold transition-colors sm:block sm:w-full ${
                          selected
                            ? "border-red bg-red text-paper"
                            : "border-transparent bg-paper text-ink hover:border-red hover:text-red"
                        }`}
                      >
                        {shortcut.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="min-w-0 flex-1 p-4">
              <p className="mb-3 text-sm font-bold text-ink">自定义日期范围</p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="block text-[11px] font-bold text-muted">
                  <span className="mb-1.5 block">{startLabel}</span>
                  <DatePicker
                    value={draftStartDate}
                    onChange={setDraftStartDate}
                    disabledDate={disabledStartDate}
                    editable={editable}
                    ariaLabel={startLabel}
                  />
                </label>
                <span className="hidden pb-2 text-muted sm:block">—</span>
                <label className="block text-[11px] font-bold text-muted">
                  <span className="mb-1.5 block">{endLabel}</span>
                  <DatePicker
                    value={draftEndDate}
                    onChange={setDraftEndDate}
                    disabledDate={disabledEndDate}
                    editable={editable}
                    ariaLabel={endLabel}
                  />
                </label>
              </div>
              {rangeInvalid ? (
                <p role="alert" className="mt-3 text-[11px] font-bold leading-5 text-red">开始日期不能晚于结束日期。</p>
              ) : editable ? (
                <p className="mt-3 text-[11px] leading-5 text-muted">可直接输入 YYYY-MM-DD，也可打开日历选择。</p>
              ) : null}
              <div className="mt-4 flex items-center justify-end gap-2 border-t border-rule pt-3">
                <button
                  type="button"
                  onClick={clearRange}
                  className="h-8 border border-rule-dark bg-paper px-3 text-xs font-bold text-red transition-colors hover:border-red"
                >
                  {clearLabel}
                </button>
                <button
                  type="button"
                  disabled={!canApply}
                  onClick={applyRange}
                  className="h-8 border border-red bg-red px-4 text-xs font-bold text-paper transition-colors hover:bg-red-dark disabled:cursor-not-allowed disabled:border-rule disabled:bg-rule disabled:text-muted"
                >
                  {applyLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
