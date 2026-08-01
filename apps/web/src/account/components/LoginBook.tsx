import {
  type FormEvent,
  type MouseEvent,
  useRef,
} from "react";
import { Link } from "react-router-dom";

interface LoginBookProps {
  email: string;
  password: string;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function LoginForm({
  email,
  password,
  busy,
  error,
  notice,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: LoginBookProps) {
  return (
    <form className="book-account-form" onSubmit={onSubmit}>
      {error && (
        <p className="book-account-form__feedback book-account-form__feedback--error" role="alert">
          {error}
        </p>
      )}
      {!error && notice && (
        <p className="book-account-form__feedback" role="status">
          {notice}
        </p>
      )}

      <div className="book-account-form__fields">
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
      </div>
    </form>
  );
}

function QuotePage() {
  return (
    <article className="opening-book__quote-page">
      <div className="quote-page__frame">
        <span className="quote-page__star" aria-hidden="true">★</span>
        <blockquote>
          <p>
            <span>“看它的过去，</span>
            <span>就可以知道它的现在；</span>
            <span>看它的过去和现在，</span>
            <span>就可以知道它的将来。”</span>
          </p>
          <cite>
            <span>——毛泽东</span>
            <small>
              一九四五年八月十三日，延安干部会议
              <br />
              《抗日战争胜利后的时局和我们的方针》
            </small>
          </cite>
        </blockquote>
      </div>
    </article>
  );
}

export function LoginBook(props: LoginBookProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const openDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;

    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        return;
      } catch {
        // Embedded browsers may expose showModal without implementing it.
      }
    }

    dialog.setAttribute("open", "");
  };

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (typeof dialog.close === "function") {
      try {
        dialog.close();
        return;
      } catch {
        // Keep the attribute fallback symmetrical with openDialog.
      }
    }

    dialog.removeAttribute("open");
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget || event.target === stageRef.current) {
      closeDialog();
    }
  };

  return (
    <main className="login-book-page">
      <section className="login-book-entry" aria-labelledby="login-book-title">
        <span className="login-book-entry__star" aria-hidden="true">★</span>
        <h1 id="login-book-title">读者入口</h1>
        <p>登录已有账号，进入 JOJO 报刊馆藏。</p>
        <div className="login-book-entry__actions">
          <button type="button" onClick={openDialog}>登录</button>
        </div>
      </section>

      <dialog
        ref={dialogRef}
        className="book-login-dialog"
        aria-label="登录"
        onClick={closeFromBackdrop}
      >
        <div ref={stageRef} className="book-dialog-stage">
          <section className="opening-book" aria-label="打开的读者登记簿">
            <div className="opening-book__right-cover">
              <article className="opening-book__login-page">
                <div className="login-page__number">
                  <span>读者登记</span>
                  <b>第 01 号</b>
                </div>
                <LoginForm {...props} />
                <footer className="login-page__folio">
                  <span>登记日期：二〇二六年</span>
                  <Link to="/">JOJO 看报</Link>
                </footer>
              </article>
            </div>

            <div className="opening-book__turning-cover" aria-hidden="true">
              <div className="opening-book__cover-face opening-book__cover-front">
                <span>★</span>
                <strong>读者登录</strong>
                <small>全世界无产者，联合起来！</small>
              </div>
              <div className="opening-book__cover-face opening-book__cover-back">
                <QuotePage />
              </div>
            </div>

            <span className="opening-book__gutter" aria-hidden="true" />
          </section>
        </div>
      </dialog>
    </main>
  );
}
