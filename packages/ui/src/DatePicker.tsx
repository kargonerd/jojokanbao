import { useState, useRef, useEffect } from "react";

interface DatePickerProps {
  value: string; // yyyyMMdd
  onChange: (date: string) => void;
  disabledDate?: (dateStr: string) => boolean;
  format?: string;
  className?: string;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

function parseDate(str: string): { year: number; month: number; day: number } | null {
  if (!str || str.length !== 8) return null;
  const y = parseInt(str.slice(0, 4));
  const m = parseInt(str.slice(4, 6));
  const d = parseInt(str.slice(6, 8));
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return { year: y, month: m - 1, day: d };
}

function toDateStr(y: number, m: number, d: number): string {
  return `${y}${String(m + 1).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

function formatDisplay(str: string): string {
  if (!str || str.length !== 8) return "";
  return `${str.slice(0, 4)}年${str.slice(4, 6)}月${str.slice(6, 8)}日`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  // 0=Mon, 6=Sun
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

export function DatePicker({ value, onChange, disabledDate, className = "" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const parsed = parseDate(value);
  const [viewYear, setViewYear] = useState(parsed?.year ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? new Date().getMonth());
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Sync view when value changes
  useEffect(() => {
    if (parsed) {
      setViewYear(parsed.year);
      setViewMonth(parsed.month);
    }
  }, [value]);

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
  const today = new Date();
  const todayStr = toDateStr(today.getFullYear(), today.getMonth(), today.getDate());

  const handleDayClick = (day: number) => {
    const ds = toDateStr(viewYear, viewMonth, day);
    if (disabledDate?.(ds)) return;
    onChange(ds);
    setOpen(false);
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else { setViewMonth(viewMonth - 1); }
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else { setViewMonth(viewMonth + 1); }
  };

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        className="h-8 px-3 text-sm border border-rule-dark bg-paper text-ink font-serif cursor-pointer hover:border-red transition-colors"
        onClick={() => setOpen(!open)}
      >
        {value ? formatDisplay(value) : "选择日期"}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 border border-rule-dark bg-paper z-50 shadow-[4px_4px_0_rgba(139,26,26,.14)] p-3 w-[280px]">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <button type="button" className="w-7 h-7 flex items-center justify-center border border-transparent hover:border-red text-ink hover:text-red cursor-pointer" onClick={prevMonth}>‹</button>
            <span className="text-sm font-bold text-ink tracking-wide">{viewYear}年 {MONTH_NAMES[viewMonth]}</span>
            <button type="button" className="w-7 h-7 flex items-center justify-center border border-transparent hover:border-red text-ink hover:text-red cursor-pointer" onClick={nextMonth}>›</button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((w) => (
              <div key={w} className="text-center text-xs font-bold text-muted py-1">{w}</div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7">
            {/* Empty cells for first week offset */}
            {Array.from({ length: firstDay }, (_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {/* Day cells */}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
              const ds = toDateStr(viewYear, viewMonth, day);
              const isToday = ds === todayStr;
              const isSelected = ds === value;
              const isDisabled = disabledDate?.(ds);

              return (
                <button
                  key={day}
                  type="button"
                  disabled={isDisabled}
                  className={`w-full h-8 text-xs font-bold cursor-pointer border-0 bg-transparent transition-colors
                    ${isSelected ? "bg-red text-cream" : isToday ? "text-red" : isDisabled ? "text-rule cursor-not-allowed" : "text-ink hover:text-red"}
                  `}
                  onClick={() => handleDayClick(day)}
                >
                  {day}
                </button>
              );
            })}
          </div>
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const years = [];
  for (let y = max; y >= min; y--) years.push(y);

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        className="h-8 px-3 text-sm border border-rule-dark bg-paper text-ink font-serif cursor-pointer hover:border-red transition-colors"
        onClick={() => setOpen(!open)}
      >
        {value ? `${value}年` : "选择年份"}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 border border-rule-dark bg-paper z-50 shadow-[4px_4px_0_rgba(139,26,26,.14)] p-2 w-[120px] max-h-[300px] overflow-y-auto">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              className={`w-full h-7 text-xs font-bold cursor-pointer border-0 bg-transparent transition-colors text-left px-2
                ${String(y) === value ? "bg-red text-cream" : "text-ink hover:text-red"}
              `}
              onClick={() => { onChange(String(y)); setOpen(false); }}
            >
              {y}年
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
