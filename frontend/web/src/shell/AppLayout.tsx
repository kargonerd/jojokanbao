import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { useAccountSessionStore } from "../account/session";
import { rollout } from "../rollout";
import { APP_NAVIGATION_ITEMS, AppHeader, type AppNavigationItem } from "./AppHeader";
import "./styles.css";

export function buildAppNavigationItems(
  authenticated: boolean,
  capabilities = { rag: rollout.rag, times: rollout.times },
): readonly AppNavigationItem[] {
  const primaryItems = APP_NAVIGATION_ITEMS.filter((item) => item.href !== "/support");
  const aboutItem = APP_NAVIGATION_ITEMS.find((item) => item.href === "/support");
  return [
    ...primaryItems,
    ...(authenticated && capabilities.rag ? [{ label: "AI", href: "/rag" }] : []),
    ...(authenticated && capabilities.times ? [{ label: "时事", href: "/times" }] : []),
    ...(aboutItem ? [aboutItem] : []),
  ];
}

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
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const resolvedNavigationItems = navigationItems || buildAppNavigationItems(accountInitialized && Boolean(userId));
  return (
    <div className={["app-shell", className].filter(Boolean).join(" ")}>
      <AppHeader actions={headerActions} navigationItems={resolvedNavigationItems} navigationLabel={navigationLabel} />
      <Outlet />
    </div>
  );
}
