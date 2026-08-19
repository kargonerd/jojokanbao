import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader, type AppNavigationItem } from "./AppHeader";
import "./styles.css";

export function AppLayout({
  navigationItems,
  navigationLabel,
  headerActions,
  className,
}: {
  navigationItems?: readonly AppNavigationItem[];
  navigationLabel?: string;
  headerActions?: ReactNode;
  className?: string;
} = {}) {
  return (
    <div className={["app-shell", className].filter(Boolean).join(" ")}>
      <AppHeader actions={headerActions} navigationItems={navigationItems} navigationLabel={navigationLabel} />
      <Outlet />
    </div>
  );
}
