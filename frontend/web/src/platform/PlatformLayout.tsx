import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { PlatformHeader, type PlatformNavigationItem } from "./PlatformHeader";
import "./styles.css";

export function PlatformLayout({
  navigationItems,
  navigationLabel,
  headerActions,
  className,
}: {
  navigationItems?: readonly PlatformNavigationItem[];
  navigationLabel?: string;
  headerActions?: ReactNode;
  className?: string;
} = {}) {
  return (
    <div className={["platform-shell", className].filter(Boolean).join(" ")}>
      <PlatformHeader actions={headerActions} navigationItems={navigationItems} navigationLabel={navigationLabel} />
      <Outlet />
    </div>
  );
}
