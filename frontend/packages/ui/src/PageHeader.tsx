import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  eyebrowClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className = "",
  eyebrowClassName = "kicker",
  titleClassName = "text-xl md:text-2xl font-bold text-ink tracking-wider m-0",
  descriptionClassName = "mt-2 text-sm text-muted leading-6 m-0",
}: PageHeaderProps) {
  return (
    <div className={`mb-6 flex flex-wrap items-start justify-between gap-4 ${className}`}>
      <div>
        {eyebrow && <span className={eyebrowClassName}>{eyebrow}</span>}
        <h1 className={titleClassName}>{title}</h1>
        {description && <p className={descriptionClassName}>{description}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
