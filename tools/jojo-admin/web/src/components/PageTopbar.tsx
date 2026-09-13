import type { ReactNode } from "react";

export function PageTopbar({
  title,
  description,
  aside,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="page-topbar">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {aside}
    </header>
  );
}
