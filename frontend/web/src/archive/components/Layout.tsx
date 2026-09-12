import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader, type AppNavigationItem } from "../../shell/AppHeader";

export function Layout({ navigationItems, headerActions, className }: {
  navigationItems?: readonly AppNavigationItem[];
  headerActions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={["app-shell archive-shell flex flex-col overflow-hidden", className].filter(Boolean).join(" ")}>
      <AppHeader actions={headerActions} navigationItems={navigationItems} />
      <main className="min-h-0 flex-1 overflow-hidden"><Outlet /></main>
    </div>
  );
}
