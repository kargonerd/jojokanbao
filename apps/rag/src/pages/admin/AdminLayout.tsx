import { Outlet, NavLink, Navigate } from "react-router-dom";
import { useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { Button } from "@jojo/ui";

export function AdminLayout() {
  const { isAuthenticated, login, logout } = useAuthStore();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  if (!isAuthenticated) {
    return (
      <div className="h-screen flex items-center justify-center bg-paper">
        <div className="w-80 p-8 border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]">
          <h1 className="text-xl font-bold text-ink mb-4">管理后台</h1>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} placeholder="输入密码" className="w-full h-10 text-sm mb-3" />
          {error && <p className="text-xs text-red mb-3">{error}</p>}
          <Button onClick={handleLogin} className="w-full">登录</Button>
        </div>
      </div>
    );
  }

  async function handleLogin() {
    const ok = await login(password);
    if (!ok) setError("密码错误");
  }

  return (
    <div className="h-screen flex">
      <aside className="w-48 shrink-0 border-r border-rule bg-paper p-4">
        <h2 className="text-sm font-bold text-red tracking-wider mb-4">管理后台</h2>
        <nav className="space-y-1">
          <NavLink to="/admin/accounts" className={({ isActive }) => `block px-3 py-2 text-sm font-bold no-underline ${isActive ? "text-red" : "text-ink hover:text-red"}`}>账号管理</NavLink>
          <NavLink to="/admin/libraries" className={({ isActive }) => `block px-3 py-2 text-sm font-bold no-underline ${isActive ? "text-red" : "text-ink hover:text-red"}`}>知识库</NavLink>
        </nav>
        <button onClick={logout} className="mt-8 text-xs text-muted border-0 bg-transparent hover:text-red cursor-pointer">退出登录</button>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
