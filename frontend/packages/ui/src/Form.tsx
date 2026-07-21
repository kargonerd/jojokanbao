import type { InputHTMLAttributes, ReactNode } from "react";

interface FieldProps {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({ label, children, className = "" }: FieldProps) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-bold text-muted mb-1.5 tracking-wide">{label}</span>}
      {children}
    </label>
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`h-9 text-sm ${className}`} {...props} />;
}

