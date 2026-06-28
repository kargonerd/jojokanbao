import { useEffect, useRef, useState } from "react";

interface DatePickerProps {
  value: string; // yyyyMMdd
  onChange: (date: string) => void;
  disabledDate?: (dateStr: string) => boolean;
  format?: string;
  className?: string;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const MONTH_LABELS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

type PanelMode = "date" | "month" | "year";

function parseDate(str: string): { year: number; month: number; day: number } | null {
  if (!str || str.length !== 8) return null;
  const year = Number(str.slice(0, 4));
  const month = Number(str.slice(4, 6));
  const day = Number(str.slice(6, 8));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return { year, month: month - 1, day };
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}${String(month + 1).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function formatDisplay(str: string): string {
  if (!str || str.length !== 8) return "";
  return `${str.slice(0, 4)}年${str.slice(4, 6)}月${str.slice(6, 8)}日`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

function getDecadeStart(year: number): number {
  return Math.floor(year / 10) * 10;
}

export function DatePicker({ value, onChange, disabledDate, className = "" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const parsed = parseDate(value);
  const today = new Date();
  const [panelMode, setPanelMode] = useState<PanelMode>("date");
  const [viewYear, setViewYear] = useState(parsed?.year ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? today.getMonth());
  const [decadeStart, setDecadeStart] = useState(getDecadeStart(parsed?.year ?? today.getFullYear()));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!parsed) return;
    setViewYear(parsed.year);
    setViewMonth(parsed.month);
    setDecadeStart(getDecadeStart(parsed.year));
  }, [value]);

  const switchPanel = (mode: PanelMode) => {
    setPanelMode(mode);
    if (mode === "year") setDecadeStart(getDecadeStart(viewYear));
  };

  const prevMonth = () => {
    if (panelMode === "year") {
      setDecadeStart((year) => year - 10);
      return;
    }
    if (panelMode === "month") {
      setViewYear((year) => year - 1);
      return;
    }
    if (viewMonth === 0) {
      setViewYear((year) => year - 1);
      setViewMonth(11);
    } else {
      setViewMonth((month) => month - 1);
    }
  };

  const nextMonth = () => {
    if (panelMode === "year") {
      setDecadeStart((year) => year + 10);
      return;
    }
    if (panelMode === "month") {
      setViewYear((year) => year + 1);
      return;
    }
    if (viewMonth === 11) {
      setViewYear((year) => year + 1);
      setViewMonth(0);
    } else {
      setViewMonth((month) => month + 1);
    }
  };

  const prevYear = () => setViewYear((year) => year - 1);
  const nextYear = () => setViewYear((year) => year + 1);

  const handleDayClick = (day: number) => {
    const dateStr = toDateStr(viewYear, viewMonth, day);
    if (disabledDate?.(dateStr)) return;
    onChange(dateStr);
    setOpen(false);
    setPanelMode("date");
  };

  const handleYearClick = (year: number) => {
    setViewYear(year);
    setPanelMode("month");
  };

  const handleMonthClick = (month: number) => {
    setViewMonth(month);
    setPanelMode("date");
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
  const todayStr = toDateStr(today.getFullYear(), today.getMonth(), today.getDate());
  const selectedStr = value && value.length === 8 ? value : "";

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        className="h-8 w-full px-2 text-xs border border-rule-dark bg-paper text-ink font-serif cursor-pointer hover:border-red transition-colors sm:w-auto sm:px-3 sm:text-sm"
        onClick={() => {
          setOpen((current) => !current);
          setPanelMode("date");
        }}
      >
        {value ? formatDisplay(value) : "选择日期"}
      </button>

      {open && (
        <div className="fixed left-3 right-3 top-[96px] z-[80] border border-rule-dark bg-paper p-3 shadow-[4px_4px_0_rgba(139,26,26,.14)] sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:w-[320px]">
          <div className="relative mb-3 flex h-8 items-center justify-between">
            {panelMode === "date" ? (
              <button type="button" className="h-8 w-8 text-[15px] leading-none text-muted transition-colors hover:text-red" onClick={prevYear} aria-label="上一年">
                &#171;
              </button>
            ) : null}
            <button type="button" className="h-8 w-8 text-[15px] leading-none text-muted transition-colors hover:text-red" onClick={prevMonth} aria-label={panelMode === "year" ? "上十年" : panelMode === "month" ? "上一年" : "上一月"}>
              &#8249;
            </button>

            <div className="flex flex-1 items-center justify-center gap-1 text-sm font-bold text-ink tracking-wide">
              {panelMode === "year" ? (
                <span>{decadeStart} 年 - {decadeStart + 9} 年</span>
              ) : (
                <>
                  <button type="button" className="px-1 transition-colors hover:text-red" onClick={() => switchPanel("year")}>
                    {viewYear} 年
                  </button>
                  {panelMode === "date" ? (
                    <button type="button" className="px-1 transition-colors hover:text-red" onClick={() => switchPanel("month")}>
                      {MONTH_NAMES[viewMonth]}
                    </button>
                  ) : null}
                </>
              )}
            </div>

            <button type="button" className="h-8 w-8 text-[15px] leading-none text-muted transition-colors hover:text-red" onClick={nextMonth} aria-label={panelMode === "year" ? "下十年" : panelMode === "month" ? "下一年" : "下一月"}>
              &#8250;
            </button>
            {panelMode === "date" ? (
              <button type="button" className="h-8 w-8 text-[15px] leading-none text-muted transition-colors hover:text-red" onClick={nextYear} aria-label="下一年">
                &#187;
              </button>
            ) : null}
          </div>

          {panelMode === "date" ? (
            <>
              <div className="grid grid-cols-7 mb-1">
                {WEEKDAYS.map((weekday) => (
                  <div key={weekday} className="text-center text-xs font-bold text-muted py-1">
                    {weekday}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {Array.from({ length: firstDay }, (_, index) => (
                  <div key={`empty-${index}`} className="h-9" />
                ))}
                {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
                  const dateStr = toDateStr(viewYear, viewMonth, day);
                  const isSelected = dateStr === selectedStr;
                  const isToday = dateStr === todayStr;
                  const isDisabled = disabledDate?.(dateStr);

                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={isDisabled}
                      className={`flex h-9 w-full items-center justify-center border-0 bg-transparent text-xs font-bold transition-colors ${isDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
                      onClick={() => handleDayClick(day)}
                    >
                      <span
                        className={`flex h-7 w-7 items-center justify-center rounded-[2px] transition-colors
                          ${isSelected ? "bg-red text-cream" : isToday ? "text-red" : isDisabled ? "text-rule opacity-40" : "text-ink hover:bg-red/10 hover:text-red"}
                        `}
                      >
                        {day}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {panelMode === "month" ? (
            <div className="grid grid-cols-4 gap-y-3 py-2">
              {MONTH_LABELS.map((label, month) => (
                <button
                  key={label}
                  type="button"
                  className="flex h-10 items-center justify-center text-sm font-bold transition-colors"
                  onClick={() => handleMonthClick(month)}
                >
                  <span className={`flex h-8 min-w-[48px] items-center justify-center rounded-[2px] px-2 transition-colors ${month === viewMonth ? "bg-red text-cream" : "text-ink hover:bg-red/10 hover:text-red"}`}>
                    {label}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {panelMode === "year" ? (
            <div className="grid grid-cols-4 gap-y-3 py-2">
              {Array.from({ length: 12 }, (_, index) => decadeStart - 1 + index).map((year) => {
                const isOuter = year < decadeStart || year > decadeStart + 9;
                return (
                  <button
                    key={year}
                    type="button"
                    className="flex h-10 items-center justify-center text-sm font-bold transition-colors"
                    onClick={() => handleYearClick(year)}
                  >
                    <span
                      className={`flex h-8 min-w-[52px] items-center justify-center rounded-[2px] px-2 transition-colors
                        ${year === viewYear ? "bg-red text-cream" : isOuter ? "text-rule opacity-60 hover:bg-red/10 hover:text-red hover:opacity-100" : "text-ink hover:bg-red/10 hover:text-red"}
                      `}
                    >
                      {year}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// Year picker for magazines
interface YearPickerProps {
  value: string; // yyyy
  onChange: (year: string) => void;
  min?: number;
  max?: number;
  className?: string;
}

export function YearPicker({ value, onChange, min = 1930, max = 2030, className = "" }: YearPickerProps) {
  const [open, setOpen] = useState(false);
  const currentYear = Number(value) || max;
  const [decadeStart, setDecadeStart] = useState(getDecadeStart(currentYear));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (value) setDecadeStart(getDecadeStart(Number(value)));
  }, [value]);

  const canGoPrevious = decadeStart > getDecadeStart(min);
  const canGoNext = decadeStart < getDecadeStart(max);

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        className="h-8 w-full px-2 text-xs border border-rule-dark bg-paper text-ink font-serif cursor-pointer hover:border-red transition-colors sm:w-auto sm:px-3 sm:text-sm"
        onClick={() => setOpen(!open)}
      >
        {value ? `${value}年` : "选择年份"}
      </button>

      {open && (
        <div className="fixed left-3 right-3 top-[96px] z-[80] border border-rule-dark bg-paper p-3 shadow-[4px_4px_0_rgba(139,26,26,.14)] sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:w-[280px]">
          <div className="mb-3 flex h-8 items-center justify-between">
            <button
              type="button"
              disabled={!canGoPrevious}
              className="h-8 w-8 text-[15px] leading-none text-muted transition-colors hover:text-red disabled:cursor-not-allowed disabled:opacity-30"
              onClick={() => setDecadeStart((year) => Math.max(getDecadeStart(min), year - 10))}
              aria-label="上十年"
            >
              &#8249;
            </button>
            <span className="text-sm font-bold text-ink tracking-wide">
              {decadeStart} 年 - {decadeStart + 9} 年
            </span>
            <button
              type="button"
              disabled={!canGoNext}
              className="h-8 w-8 text-[15px] leading-none text-muted transition-colors hover:text-red disabled:cursor-not-allowed disabled:opacity-30"
              onClick={() => setDecadeStart((year) => Math.min(getDecadeStart(max), year + 10))}
              aria-label="下十年"
            >
              &#8250;
            </button>
          </div>
          <div className="grid grid-cols-4 gap-y-3 py-2">
            {Array.from({ length: 12 }, (_, index) => decadeStart - 1 + index).map((year) => {
              const isOuter = year < decadeStart || year > decadeStart + 9;
              const isDisabled = year < min || year > max;
              return (
                <button
                  key={year}
                  type="button"
                  disabled={isDisabled}
                  className="flex h-10 items-center justify-center text-sm font-bold transition-colors disabled:cursor-not-allowed"
                  onClick={() => { onChange(String(year)); setOpen(false); }}
                >
                  <span
                    className={`flex h-8 min-w-[52px] items-center justify-center rounded-[2px] px-2 transition-colors
                      ${String(year) === value ? "bg-red text-cream" : isDisabled ? "text-rule opacity-30" : isOuter ? "text-rule opacity-60 hover:bg-red/10 hover:text-red hover:opacity-100" : "text-ink hover:bg-red/10 hover:text-red"}
                    `}
                  >
                    {year}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
