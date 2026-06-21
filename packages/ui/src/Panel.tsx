import type { HTMLAttributes, ReactNode } from "react";

interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  as?: "div" | "section" | "article" | "aside";
  inset?: boolean;
}

export function Panel({ as: Component = "div", children, inset = false, className = "", ...props }: PanelProps) {
  const insetClass = inset
    ? "border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]"
    : "border border-rule";
  return (
    <Component className={`${insetClass} bg-paper ${className}`} {...props}>
      {children}
    </Component>
  );
}
