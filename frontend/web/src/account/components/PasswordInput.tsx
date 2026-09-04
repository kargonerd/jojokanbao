import { useState, type InputHTMLAttributes } from "react";

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  showLabel: string;
  hideLabel: string;
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function PasswordInput({
  showLabel,
  hideLabel,
  className,
  disabled,
  ...inputProps
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="book-password-input">
      <input
        {...inputProps}
        className={className}
        disabled={disabled}
        type={visible ? "text" : "password"}
      />
      <button
        type="button"
        className="book-password-input__toggle"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          setVisible((current) => !current);
        }}
      >
        <EyeIcon crossed={visible} />
      </button>
    </div>
  );
}
