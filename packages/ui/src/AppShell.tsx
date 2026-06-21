import type { ReactNode } from "react";

interface AppShellProps {
  header?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  sidebarClassName?: string;
  contentClassName?: string;
}

export function AppShell({
  header,
  sidebar,
  children,
  className = "",
  headerClassName = "",
  sidebarClassName = "",
  contentClassName = "",
}: AppShellProps) {
  return (
    <div className={`h-screen flex flex-col bg-paper text-ink ${className}`}>
      {header && <header className={`h-14 shrink-0 border-b border-rule-dark z-20 ${headerClassName}`}>{header}</header>}
      <div className="min-h-0 flex-1 flex">
        {sidebar && <aside className={`shrink-0 border-r border-rule bg-paper p-4 overflow-y-auto ${sidebarClassName || "w-56"}`}>{sidebar}</aside>}
        <main className={`min-w-0 flex-1 overflow-y-auto ${contentClassName}`}>{children}</main>
      </div>
    </div>
  );
}
