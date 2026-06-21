import { Outlet, NavLink, Navigate } from "react-router-dom";
import { useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { AppShell, Button, Field, Panel, TextInput } from "@jojo/ui";

export function AdminLayout() {
  const { isAuthenticated, login, logout } = useAuthStore();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  if (!isAuthenticated) {
    return (
      <div className="h-screen flex items-center justify-center bg-paper">
        <Panel inset className="w-80 p-8">
          <h1 className="text-xl font-bold text-ink mb-4">管理后台</h1>
          <Field className="mb-3">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} placeholder="输入密码" className="w-full h-10" />
          </Field>
          {error && <p className="text-xs text-red mb-3">{error}</p>}
          <Button onClick={handleLogin} className="w-full">登录</Button>
        </Panel>
      </div>
    );
  }

  async function handleLogin() {
    const ok = await login(password);
    if (!ok) setError("密码错误");
  }

  return (
    <AppShell
      sidebar={
        <>
        <h2 className="text-sm font-bold text-red tracking-wider mb-4">管理后台</h2>
        <nav className="space-y-1">
          <NavLink to="/admin/accounts" className={({ isActive }) => `block px-3 py-2 text-sm font-bold no-underline ${isActive ? "text-red" : "text-ink hover:text-red"}`}>账号管理</NavLink>
          <NavLink to="/admin/libraries" className={({ isActive }) => `block px-3 py-2 text-sm font-bold no-underline ${isActive ? "text-red" : "text-ink hover:text-red"}`}>知识库</NavLink>
        </nav>
        <button onClick={logout} className="mt-8 text-xs text-muted border-0 bg-transparent hover:text-red cursor-pointer">退出登录</button>
        </>
      }
      sidebarClassName="w-48"
      contentClassName="p-6"
    >
      <Outlet />
    </AppShell>
  );
}
