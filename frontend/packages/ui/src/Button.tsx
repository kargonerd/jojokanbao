import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "outline" | "text";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "btn",
  outline: "btn btn-outline",
  text: "border-0 bg-transparent text-red font-bold hover:text-red-dark p-0",
};

export function Button({ variant = "primary", className = "", children, ...props }: ButtonProps) {
  return (
    <button className={`${variantClass[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}
