import type { InputHTMLAttributes, ReactNode } from "react";
import { useState } from "react";

export function AuthField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold tracking-[0.08em]">{label}</span>
      <input
        {...props}
        className={`h-12 w-full border-rule-dark bg-paper px-4 font-sans text-sm ${props.className ?? ""}`}
      />
    </label>
  );
}
export function PasswordField(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }) {
  const [visible, setVisible] = useState(false);
  const { label, ...inputProps } = props;
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold tracking-[0.08em]">{label}</span>
      <span className="relative block">
        <input
          {...inputProps}
          type={visible ? "text" : "password"}
          className={`h-12 w-full border-rule-dark bg-paper px-4 pr-16 font-sans text-sm ${inputProps.className ?? ""}`}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 border-0 bg-transparent px-4 font-sans text-[11px] font-bold text-red"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "隐藏密码" : "显示密码"}
        >
          {visible ? "隐藏" : "显示"}
        </button>
      </span>
    </label>
  );
}

export function FormFeedback({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (!error && !notice) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className={`border-l-4 px-4 py-3 text-sm leading-6 ${error ? "border-red bg-red/5 text-red-dark" : "border-ink bg-soft text-ink"}`}
    >
      {error ?? notice}
    </div>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="flex h-12 w-full items-center justify-center border border-red bg-red px-5 text-sm font-black tracking-[0.14em] text-cream transition-colors hover:bg-paper hover:text-red disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? "处理中…" : children}
    </button>
  );
}
