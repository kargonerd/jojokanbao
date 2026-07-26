import type { ReactNode } from "react";

export function PageTopbar({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description?: string; aside?: ReactNode }) {
  return (
    <header className="page-topbar">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {aside}
    </header>
  );
}
