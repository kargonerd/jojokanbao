import type { FormEvent } from "react";

interface FeedbackProps {
  error: string | null;
  notice: string | null;
}

function FormFeedback({ error, notice }: FeedbackProps) {
  if (!error && !notice) return null;
  return (
    <p
      className={`book-account-form__feedback${error ? " book-account-form__feedback--error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ?? notice}
    </p>
  );
}

interface LoginFormProps extends FeedbackProps {
  email: string;
  password: string;
  busy: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function LoginForm({
  email,
  password,
  busy,
  error,
  notice,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: LoginFormProps) {
  return (
    <form className="book-account-form__fields" onSubmit={onSubmit}>
      <FormFeedback error={error} notice={notice} />
      <label>
        <span>邮箱</span>
        <input
          type="email"
          name="email"
          placeholder="name@example.com"
          autoComplete="email"
          value={email}
          disabled={busy}
          required
          onChange={(event) => onEmailChange(event.target.value)}
        />
      </label>
      <label>
        <span>密码</span>
        <input
          type="password"
          name="password"
          placeholder="输入密码"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          required
          onChange={(event) => onPasswordChange(event.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "正在登录…" : "登录"}
      </button>
    </form>
  );
}

interface RegisterFormProps extends FeedbackProps {
  invitationCode: string;
  email: string;
  password: string;
  confirmationEmail: string | null;
  busy: boolean;
  onInvitationCodeChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function RegisterForm({
  invitationCode,
  email,
  password,
  confirmationEmail,
  busy,
  error,
  notice,
  onInvitationCodeChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: RegisterFormProps) {
  if (confirmationEmail) {
    return (
      <div className="book-account-form__confirmation" role="status">
        <strong>请检查邮箱</strong>
        <p>确认邮件已发送到 {confirmationEmail}。</p>
        <p>打开邮件中的链接后，账号会自动激活并返回这里。</p>
      </div>
    );
  }

  return (
    <form className="book-account-form__fields" onSubmit={onSubmit}>
      <FormFeedback error={error} notice={notice} />
      <label>
        <span>邮箱</span>
        <input
          type="email"
          name="registrationEmail"
          placeholder="name@example.com"
          autoComplete="email"
          value={email}
          disabled={busy}
          required
          onChange={(event) => onEmailChange(event.target.value)}
        />
      </label>
      <label>
        <span>密码</span>
        <input
          type="password"
          name="registrationPassword"
          placeholder="至少 8 位字符"
          autoComplete="new-password"
          minLength={8}
          value={password}
          disabled={busy}
          required
          onChange={(event) => onPasswordChange(event.target.value)}
        />
      </label>
      <label>
        <span>邀请码</span>
        <input
          type="text"
          name="invitationCode"
          placeholder="6 位邀请码"
          autoComplete="off"
          autoCapitalize="characters"
          minLength={6}
          maxLength={6}
          value={invitationCode}
          disabled={busy}
          required
          onChange={(event) => onInvitationCodeChange(event.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "正在注册…" : "注册账号"}
      </button>
    </form>
  );
}
