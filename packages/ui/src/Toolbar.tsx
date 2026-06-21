import type { HTMLAttributes, ReactNode } from "react";

interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  sticky?: boolean;
}

export function Toolbar({ children, sticky = false, className = "", ...props }: ToolbarProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-4 px-4 py-3.5 border-b border-rule bg-paper ${sticky ? "sticky top-0 z-10" : ""} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

