import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  prefix?: ReactNode;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  prefix,
  disabled = false,
  className = "",
  menuClassName = "",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  function nextEnabledIndex(start: number, direction: 1 | -1): number {
    if (!options.length) return -1;
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (start + direction * offset + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return start;
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    setActiveIndex(index);
    if (option.value !== value) onChange(option.value);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        setActiveIndex((current) => nextEnabledIndex(current, direction));
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const start = event.key === "Home" ? options.length - 1 : 0;
      const direction = event.key === "Home" ? 1 : -1;
      setOpen(true);
      setActiveIndex(nextEnabledIndex(start, direction));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else {
        setOpen(true);
        setActiveIndex(selectedIndex);
      }
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
          setActiveIndex(selectedIndex);
        }}
        onKeyDown={handleKeyDown}
        className="flex h-9 w-full items-center border border-rule-dark bg-paper text-left text-xs text-ink transition-colors hover:border-red focus-visible:border-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red/20 disabled:cursor-not-allowed disabled:border-rule disabled:text-muted"
      >
        {prefix ? (
          <span className="flex h-full shrink-0 items-center border-r border-rule px-3 font-sans text-[10px] font-black tracking-[0.12em] text-muted">
            {prefix}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate px-3 font-serif font-bold">{selectedOption?.label || "请选择"}</span>
        <svg
          className={`mr-3 h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180 text-red" : "text-ink"}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className={`absolute left-0 top-full z-[100] mt-1 min-w-full border-2 border-red bg-paper shadow-[5px_5px_0_rgba(139,26,26,.14)] ${menuClassName}`}>
          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-[min(52vh,28rem)] overflow-y-auto overscroll-y-contain py-1 [scrollbar-color:var(--color-red)_transparent] [scrollbar-width:thin]"
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <button
                  key={option.value}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  id={`${listboxId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={option.disabled}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  className={`relative block min-h-10 w-full border-0 bg-paper px-4 py-2 text-left font-serif text-sm leading-6 transition-colors before:absolute before:inset-y-1 before:left-0 before:w-[3px] ${
                    selected
                      ? "font-black text-red before:bg-red"
                      : active
                        ? "bg-red/5 text-red before:bg-red/35"
                        : "text-ink before:bg-transparent hover:bg-red/5 hover:text-red"
                  } disabled:cursor-not-allowed disabled:text-muted`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
