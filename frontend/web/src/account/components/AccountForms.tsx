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
  onForgotPassword: () => void;
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
  onForgotPassword,
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
      <button
        type="button"
        className="book-account-form__text-action"
        disabled={busy}
        onClick={onForgotPassword}
      >
        忘记密码？
      </button>
    </form>
  );
}

interface RegisterFormProps extends FeedbackProps {
  invitationCode: string;
  email: string;
  password: string;
  passwordConfirmation: string;
  confirmationEmail: string | null;
  confirmationCode: string;
  resendSeconds: number;
  busy: boolean;
  onInvitationCodeChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onPasswordConfirmationChange: (value: string) => void;
  onConfirmationCodeChange: (value: string) => void;
  onConfirmSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onResend: () => void;
  onEditRegistration: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function RegisterForm({
  invitationCode,
  email,
  password,
  passwordConfirmation,
  confirmationEmail,
  confirmationCode,
  resendSeconds,
  busy,
  error,
  notice,
  onInvitationCodeChange,
  onEmailChange,
  onPasswordChange,
  onPasswordConfirmationChange,
  onConfirmationCodeChange,
  onConfirmSubmit,
  onResend,
  onEditRegistration,
  onSubmit,
}: RegisterFormProps) {
  if (confirmationEmail) {
    return (
      <form className="book-account-form__fields" onSubmit={onConfirmSubmit}>
        <div className="book-account-form__proof" role="status">
          <span>Identity proof / 十分钟内有效</span>
          <strong>{confirmationCode || "000000"}</strong>
        </div>
        <p className="book-account-form__hint">验证码已发送到 {confirmationEmail}</p>
        <FormFeedback error={error} notice={notice} />
        <label>
          <span>6 位验证码</span>
          <input
            className="book-account-form__code"
            type="text"
            name="confirmationCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={confirmationCode}
            disabled={busy}
            required
            onChange={(event) => onConfirmationCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "正在验证…" : "确认并完成注册"}
        </button>
        <button
          type="button"
          className="book-account-form__text-action"
          disabled={busy || resendSeconds > 0}
          onClick={onResend}
        >
          {resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : "重新发送验证码"}
        </button>
        <button
          type="button"
          className="book-account-form__text-action"
          disabled={busy}
          onClick={onEditRegistration}
        >
          修改注册信息
        </button>
      </form>
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
        <span>再次输入密码</span>
        <input
          type="password"
          name="registrationPasswordConfirmation"
          placeholder="重复输入密码"
          autoComplete="new-password"
          minLength={8}
          value={passwordConfirmation}
          disabled={busy}
          required
          onChange={(event) => onPasswordConfirmationChange(event.target.value)}
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
        {busy ? "正在注册…" : "发送注册验证码"}
      </button>
    </form>
  );
}

export type RecoveryStep = "email" | "code" | "password";

interface RecoveryFormProps extends FeedbackProps {
  step: RecoveryStep;
  email: string;
  code: string;
  password: string;
  passwordConfirmation: string;
  resendSeconds: number;
  busy: boolean;
  onEmailChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onPasswordConfirmationChange: (value: string) => void;
  onResend: () => void;
  onBackToLogin: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function RecoveryForm({
  step,
  email,
  code,
  password,
  passwordConfirmation,
  resendSeconds,
  busy,
  error,
  notice,
  onEmailChange,
  onCodeChange,
  onPasswordChange,
  onPasswordConfirmationChange,
  onResend,
  onBackToLogin,
  onSubmit,
}: RecoveryFormProps) {
  return (
    <form className="book-account-form__fields" onSubmit={onSubmit}>
      <div className="book-account-form__section-title">
        <strong>{step === "password" ? "设置新密码" : "找回密码"}</strong>
        <span>{step === "email" ? "验证码会发送到你的注册邮箱" : `正在验证 ${email}`}</span>
      </div>
      <FormFeedback error={error} notice={notice} />
      {step === "email" && (
        <label>
          <span>注册邮箱</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            disabled={busy}
            required
            onChange={(event) => onEmailChange(event.target.value)}
          />
        </label>
      )}
      {step === "code" && (
        <label>
          <span>6 位验证码</span>
          <input
            className="book-account-form__code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            disabled={busy}
            required
            onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </label>
      )}
      {step === "password" && (
        <>
          <label>
            <span>新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              disabled={busy}
              required
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </label>
          <label>
            <span>再次输入新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={passwordConfirmation}
              disabled={busy}
              required
              onChange={(event) => onPasswordConfirmationChange(event.target.value)}
            />
          </label>
        </>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "处理中…" : step === "email" ? "发送验证码" : step === "code" ? "验证身份" : "保存新密码"}
      </button>
      {step === "code" && (
        <button
          type="button"
          className="book-account-form__text-action"
          disabled={busy || resendSeconds > 0}
          onClick={onResend}
        >
          {resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : "重新发送验证码"}
        </button>
      )}
      <button type="button" className="book-account-form__text-action" disabled={busy} onClick={onBackToLogin}>
        返回登录
      </button>
    </form>
  );
}
