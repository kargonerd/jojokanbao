import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";

export type AccountMode = "login" | "register" | "recover";

interface AccountBookProps {
  mode: AccountMode;
  busy: boolean;
  open?: boolean;
  children: ReactNode;
  onModeChange: (mode: AccountMode) => void;
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

export function AccountBook({
  mode,
  busy,
  open = false,
  children,
  onModeChange,
}: AccountBookProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const isRegistering = mode === "register";
  const isRecovering = mode === "recover";

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

  useEffect(() => {
    if (open) openDialog();
  }, [open]);

  const openAccount = (nextMode: AccountMode) => {
    // Commit the selected form before the native dialog starts its cover animation.
    flushSync(() => onModeChange(nextMode));
    openDialog();
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
        <p>登录已有账号，或凭邀请码完成注册。</p>
        <div className="login-book-entry__actions">
          <button type="button" disabled={busy} onClick={() => openAccount("login")}>登录</button>
          <button type="button" disabled={busy} onClick={() => openAccount("register")}>注册</button>
        </div>
        <Link className="login-book-entry__about" to="/support">关于 JOJO 看报 →</Link>
      </section>

      <dialog
        ref={dialogRef}
        className="book-login-dialog"
        aria-label={isRegistering ? "注册" : isRecovering ? "找回密码" : "登录"}
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
                <div className="book-account-form">
                  <div className="book-account-form__modes" role="group" aria-label="账号操作">
                    <button
                      type="button"
                      aria-pressed={mode === "login"}
                      disabled={busy}
                      onClick={() => onModeChange("login")}
                    >
                      登录
                    </button>
                    <button
                      type="button"
                      aria-pressed={isRegistering}
                      disabled={busy}
                      onClick={() => onModeChange("register")}
                    >
                      注册
                    </button>
                  </div>
                  {children}
                </div>
                <footer className="login-page__folio">
                  <span>登记日期：二〇二六年</span>
                  <span><Link to="/">首页</Link> · <Link to="/support">关于</Link></span>
                </footer>
              </article>
            </div>

            <div className="opening-book__turning-cover" aria-hidden="true">
              <div className="opening-book__cover-face opening-book__cover-front">
                <span>★</span>
                <strong>{isRegistering ? "读者注册" : isRecovering ? "找回密码" : "读者登录"}</strong>
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
