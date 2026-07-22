import type { ReactNode } from "react";
import { Brand } from "./Brand";

export function AccountShell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className="account-shell min-h-screen bg-cream text-ink">
      <header className="border-b border-rule-dark bg-paper">
        <div className="mx-auto flex h-[72px] max-w-6xl items-center justify-between px-5 md:px-8">
          <Brand />
          <span className="hidden font-sans text-[10px] font-semibold tracking-[0.26em] text-muted uppercase sm:block">
            JOJO Unified Identity
          </span>
        </div>
      </header>
      <main className={compact ? "mx-auto w-full max-w-6xl px-5 py-8 md:px-8" : "account-main"}>{children}</main>
      <footer className="border-t border-rule bg-paper px-5 py-5 text-center font-sans text-[10px] tracking-[0.2em] text-muted uppercase">
        一个账号，通行 JOJO 服务 · Account Service 2026
      </footer>
    </div>
  );
}
