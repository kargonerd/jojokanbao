import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
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
  searchable = false,
  searchPlaceholder = "搜索选项",
  emptyText = "没有匹配项",
  className = "",
  menuClassName = "",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = useMemo(
    () => normalizedQuery
      ? options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery))
      : options,
    [normalizedQuery, options],
  );
  const selectedVisibleIndex = visibleOptions.findIndex((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const firstEnabledIndex = visibleOptions.findIndex((option) => !option.disabled);
    setActiveIndex(selectedVisibleIndex >= 0 ? selectedVisibleIndex : firstEnabledIndex);
    if (searchable) searchRef.current?.focus();
  }, [open, searchable, selectedVisibleIndex, visibleOptions]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  function nextEnabledIndex(start: number, direction: 1 | -1): number {
    if (!visibleOptions.length) return -1;
    for (let offset = 1; offset <= visibleOptions.length; offset += 1) {
      const index = (start + direction * offset + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[index]?.disabled) return index;
    }
    return start;
  }

  function choose(index: number) {
    const option = visibleOptions[index];
    if (!option || option.disabled) return;
    setOpen(false);
    setQuery("");
    setActiveIndex(index);
    if (option.value !== value) onChange(option.value);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setQuery("");
      }
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      setQuery("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        setQuery("");
        setOpen(true);
      } else {
        setActiveIndex((current) => nextEnabledIndex(current, direction));
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const start = event.key === "Home" ? visibleOptions.length - 1 : 0;
      const direction = event.key === "Home" ? 1 : -1;
      setOpen(true);
      setActiveIndex(nextEnabledIndex(start, direction));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else {
        setQuery("");
        setOpen(true);
      }
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQuery("");
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      setQuery("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => nextEnabledIndex(current, direction));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
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
          setQuery("");
          setOpen((current) => !current);
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
        <div className={`absolute left-0 top-full z-[100] mt-1 w-full border-2 border-red bg-paper shadow-[5px_5px_0_rgba(139,26,26,.14)] ${menuClassName}`}>
          {searchable ? (
            <div className="flex h-10 items-center border-b border-rule bg-paper px-3 focus-within:border-red">
              <svg
                aria-hidden="true"
                className="mr-2 h-3.5 w-3.5 shrink-0 text-muted"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="4.5" />
                <path d="m10.5 10.5 3 3" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                value={query}
                aria-label={searchPlaceholder}
                aria-controls={listboxId}
                aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
                placeholder={searchPlaceholder}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-serif text-xs text-ink shadow-none outline-none placeholder:text-muted focus:border-0 focus:ring-0"
              />
            </div>
          ) : null}
          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-[min(52vh,28rem)] overflow-y-auto overscroll-y-contain py-1 [scrollbar-color:var(--color-red)_transparent] [scrollbar-width:thin]"
          >
            {visibleOptions.map((option, index) => {
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
                  <span className="block truncate" title={option.label}>{option.label}</span>
                </button>
              );
            })}
            {visibleOptions.length === 0 ? (
              <p className="m-0 px-4 py-5 text-center font-serif text-xs text-muted">{emptyText}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
