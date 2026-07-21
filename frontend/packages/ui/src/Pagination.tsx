interface PaginationProps {
  current: number;
  total: number;
  onChange: (page: number) => void;
}

export function Pagination({ current, total, onChange }: PaginationProps) {
  if (total <= 1) return null;

  const pages: (number | "...")[] = [];
  for (let p = 1; p <= total; p++) {
    if (p === 1 || p === total || (p >= current - 2 && p <= current + 2)) {
      pages.push(p);
    } else if (pages[pages.length - 1] !== "...") {
      pages.push("...");
    }
  }

  return (
    <nav className="flex items-center justify-center gap-1 mt-8">
      <button className="w-8 h-8 text-sm font-bold border border-transparent bg-paper text-ink disabled:opacity-30" disabled={current <= 1} onClick={() => onChange(current - 1)}>‹</button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`e${i}`} className="px-1 text-muted">…</span>
        ) : (
          <button key={p} className={`w-8 h-8 text-sm font-bold border bg-paper ${p === current ? "border-red text-red" : "border-transparent text-ink hover:text-red"}`} onClick={() => onChange(p)}>
            {p}
          </button>
        )
      )}
      <button className="w-8 h-8 text-sm font-bold border border-transparent bg-paper text-ink disabled:opacity-30" disabled={current >= total} onClick={() => onChange(current + 1)}>›</button>
    </nav>
  );
}
