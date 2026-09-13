import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAdminSession } from "../auth/session";
import { adminNavigation, NavigationIcon } from "./navigation";
import logo from "../../../../../frontend/web/public/brand/jojo-kanbao-logo.png";

export function AdminShell() {
  const { user, logout } = useAdminSession();
  const { pathname } = useLocation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const items = adminNavigation.filter((item) => user?.permissions.includes(item.permission));
  const current = adminNavigation.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  const allowed = !current || user?.permissions.includes(current.permission);
  return <div className="admin-shell">
    <a className="admin-skip" href="#admin-main">跳到工作区</a>
    <header className="admin-header">
      <NavLink className="admin-brand" to="/"><img src={logo} alt="JOJO 看报" /><span>管理台</span></NavLink>
      <nav aria-label="站点导航"><NavLink to="/">工作台</NavLink><a href="https://reader.jojokanbao.cn/library" target="_blank" rel="noreferrer">查看线上书库</a></nav>
      <div className="admin-account"><span title={user?.email}>{user?.email}</span><button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await logout(); } catch { setError("退出失败，请重试。"); } finally { setBusy(false); }
      }}>{busy ? "正在退出…" : "退出"}</button>{error && <span role="alert">{error}</span>}</div>
    </header>
    <aside className="admin-nav">
      <nav aria-label="管理台导航">
        <NavLink end className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`} to="/"><NavigationIcon name="home" /><span>工作台</span></NavLink>
        {items.map((item) => <NavLink key={item.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`} to={item.to}><NavigationIcon name={item.icon} /><span>{item.label}</span></NavLink>)}
      </nav>
    </aside>
    <section id="admin-main" className="admin-content" tabIndex={-1}>
      {allowed ? <Outlet /> : <div className="admin-denied"><h1>没有访问权限</h1><p>你的账号不能管理这部分内容。</p><NavLink to="/">返回工作台</NavLink></div>}
    </section>
  </div>;
}
