import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useUnreadNotifications } from "../notifications/useUnreadNotifications";
import { signOutPlatformAccount, usePlatformAccountStore } from "./accountSession";

export function PlatformAccountMenu() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const displayName = usePlatformAccountStore((state) => state.displayName);
  const { userId, unreadCount } = useUnreadNotifications();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  if (!userId) return <Link className="platform-login" to="/account">登录</Link>;

  const name = displayName || "账号";
  const countLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signOutPlatformAccount();
      setOpen(false);
      navigate("/", { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出登录失败");
      setBusy(false);
    }
  }

  return (
    <div className="platform-account-menu" ref={rootRef}>
      <button
        type="button"
        className="platform-account-trigger"
        aria-label={`${name}，账号菜单${unreadCount ? `，${unreadCount} 条未读通知` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="platform-login-label">{name}</span>
        {unreadCount ? <b aria-hidden="true">{countLabel}</b> : null}
      </button>

      {open ? <section className="platform-account-popover" role="menu" aria-label="读者菜单">
        <nav aria-label="账号快捷入口">
          <Link role="menuitem" to="/notifications" onClick={() => setOpen(false)}><span>通知</span>{unreadCount ? <b>{countLabel}</b> : null}</Link>
          <Link role="menuitem" to="/#book-shelf-title" onClick={() => setOpen(false)}><span>我的书架</span></Link>
          <Link role="menuitem" to="/account" onClick={() => setOpen(false)}><span>账号</span></Link>
        </nav>
        {error ? <p role="alert">{error}</p> : null}
        <button type="button" role="menuitem" className="platform-account-signout" disabled={busy} onClick={() => void signOut()}>{busy ? "正在退出…" : "退出登录"}</button>
      </section> : null}
    </div>
  );
}
