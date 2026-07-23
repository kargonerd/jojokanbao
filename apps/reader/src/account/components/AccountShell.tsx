import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function AccountShell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className="account-shell">
      <div className="account-utility">
        <Link to="/">← 返回 JOJO 看报</Link>
        <span>中国报刊数字馆藏</span>
      </div>
      <main className={compact ? "account-main account-main--compact" : "account-main"}>{children}</main>
      <footer className="account-footer">
        <span>JOJO 看报</span>
        <span>数字馆藏 · 二〇二六</span>
      </footer>
    </div>
  );
}
