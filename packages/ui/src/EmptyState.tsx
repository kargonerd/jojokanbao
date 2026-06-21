import type { ReactNode } from "react";

interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, actions, className = "" }: EmptyStateProps) {
  return (
    <div className={`py-16 text-center ${className}`}>
      <p className="text-xl font-bold text-ink mb-2">{title}</p>
      {description && <p className="text-sm text-muted m-0">{description}</p>}
      {actions && <div className="mt-5 flex justify-center gap-2">{actions}</div>}
    </div>
  );
}

