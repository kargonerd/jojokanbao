import { Fragment, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { useAccountSessionStore } from "../account/session";
import { rollout } from "../rollout";
import { APP_NAVIGATION_ITEMS, AppHeader, type AppNavigationItem } from "./AppHeader";
import "./styles.css";

export function buildAppNavigationItems(
  authenticated: boolean,
  capabilities = { rag: true, times: rollout.times },
): readonly AppNavigationItem[] {
  const primaryItems = APP_NAVIGATION_ITEMS.filter((item) => item.href !== "/support");
  const aboutItem = APP_NAVIGATION_ITEMS.find((item) => item.href === "/support");
  return [
    ...primaryItems,
    ...(authenticated && capabilities.rag ? [{ label: "AI", href: "/rag", badge: "Beta" }] : []),
    ...(authenticated && capabilities.times ? [{ label: "时事", href: "/times", badge: "Beta" }] : []),
    ...(aboutItem ? [aboutItem] : []),
  ];
}

export function AppLayout({
  navigationItems,
  navigationLabel,
  headerActions,
  className,
  children,
  showHeader = true,
}: {
  navigationItems?: readonly AppNavigationItem[];
  navigationLabel?: string;
  headerActions?: ReactNode;
  className?: string;
  children?: ReactNode;
  showHeader?: boolean;
} = {}) {
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const publicTimesAudit = import.meta.env.VITE_TIMES_AUDIT_PUBLIC === "true";
  const resolvedNavigationItems =
    navigationItems || buildAppNavigationItems((accountInitialized && Boolean(userId)) || publicTimesAudit);
  return (
    <div className={["app-shell", className].filter(Boolean).join(" ")}>
      {showHeader ? <AppHeader key="app-header" actions={headerActions} navigationItems={resolvedNavigationItems} navigationLabel={navigationLabel} /> : null}
      <Fragment key="app-content">{children ?? <Outlet />}</Fragment>
    </div>
  );
}
