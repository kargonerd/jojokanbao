import type { HTMLAttributes, ReactNode } from "react";

interface ListItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function ListItem({ title, meta, actions, className = "", ...props }: ListItemProps) {
  return (
    <div className={`flex items-center justify-between gap-4 border border-rule bg-paper p-4 ${className}`} {...props}>
      <div className="min-w-0">
        <p className="font-bold text-ink m-0 truncate">{title}</p>
        {meta && <p className="text-xs text-muted mt-1 m-0 truncate">{meta}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
