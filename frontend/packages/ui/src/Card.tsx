import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hover?: boolean;
}

export function Card({ children, hover = true, className = "", ...props }: CardProps) {
  const hoverClass = hover
    ? "transition-all duration-[180ms] ease hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)]"
    : "";
  return (
    <div className={`border-2 border-red bg-paper ${hoverClass} ${className}`} {...props}>
      {children}
    </div>
  );
}
