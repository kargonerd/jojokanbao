import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@jojo/ui";
import { useAdminSession } from "./session";
import logo from "../../../../../frontend/web/public/brand/jojo-kanbao-logo.png";

export function AdminAccess({ children }: { children: ReactNode }) {
  const { user, ready, restore, login, error: sessionError } = useAdminSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void restore(); }, [restore]);
  useEffect(() => {
    if (!user) return;
    const verify = () => { if (document.visibilityState === "visible") void restore(); };
    window.addEventListener("focus", verify);
    return () => window.removeEventListener("focus", verify);
  }, [user, restore]);
  if (!ready) return <main className="admin-login"><p role="status">正在验证登录状态…</p></main>;
  if (user) return children;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await login(email, password); setPassword(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <main className="admin-login">
    <a href="https://reader.jojokanbao.cn" className="admin-login-brand"><img src={logo} alt="JOJO 看报" /></a>
    <form onSubmit={(event) => void submit(event)}>
      <h1>登录管理台</h1>
      <p>使用具有管理权限的 JOJO 账号。</p>
      <label htmlFor="admin-email">邮箱</label>
      <input id="admin-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor="admin-password">密码</label>
      <input id="admin-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
      {(error || sessionError) && <p role="alert" className="content-error">{error || sessionError}</p>}
      <Button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</Button>
      <a className="admin-password-help" href="https://reader.jojokanbao.cn/account" target="_blank" rel="noreferrer">前往账号页面找回密码</a>
    </form>
  </main>;
}
