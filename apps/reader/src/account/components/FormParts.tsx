import type { InputHTMLAttributes, ReactNode } from "react";
import { useState } from "react";

export function AuthField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <input
        {...props}
        className={`auth-input ${props.className ?? ""}`}
      />
    </label>
  );
}
export function PasswordField(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }) {
  const [visible, setVisible] = useState(false);
  const { label, ...inputProps } = props;
  return (
    <label className="auth-field">
      <span>{label}</span>
      <span className="password-input">
        <input
          {...inputProps}
          type={visible ? "text" : "password"}
          className={`auth-input ${inputProps.className ?? ""}`}
        />
        <button
          type="button"
          className="password-toggle"
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
      className={`form-feedback ${error ? "form-feedback--error" : "form-feedback--notice"}`}
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
      className="auth-submit"
    >
      {busy ? "处理中…" : children}
    </button>
  );
}
