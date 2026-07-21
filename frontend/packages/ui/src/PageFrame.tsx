import type { HTMLAttributes, ReactNode } from "react";

interface PageFrameProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  as?: "div" | "main" | "section";
  maxWidth?: "sm" | "md" | "lg" | "xl" | "full";
}

const maxWidthClass: Record<NonNullable<PageFrameProps["maxWidth"]>, string> = {
  sm: "max-w-xl",
  md: "max-w-3xl",
  lg: "max-w-5xl",
  xl: "max-w-6xl",
  full: "max-w-none",
};

export function PageFrame({ as: Component = "div", children, maxWidth = "lg", className = "", ...props }: PageFrameProps) {
  return (
    <Component className={`w-full ${maxWidthClass[maxWidth]} mx-auto px-5 py-6 md:px-6 md:py-8 ${className}`} {...props}>
      {children}
    </Component>
  );
}
