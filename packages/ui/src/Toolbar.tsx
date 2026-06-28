import type { HTMLAttributes, ReactNode } from "react";

interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  sticky?: boolean;
}

export function Toolbar({ children, sticky = false, className = "", ...props }: ToolbarProps) {
  return (
    <div
      className={`flex flex-nowrap items-center gap-2 px-3 py-3 border-b border-rule bg-paper sm:gap-4 sm:px-4 sm:py-3.5 ${sticky ? "sticky top-0 z-[60]" : ""} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
