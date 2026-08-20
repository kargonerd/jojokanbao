import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { useFeatureFlag } from "../featureFlags";
import { rollout } from "../rollout";
import { APP_NAVIGATION_ITEMS, AppHeader, type AppNavigationItem } from "./AppHeader";
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
  const timesEnabled = useFeatureFlag("times.workspace");
  const resolvedNavigationItems = navigationItems || [
    ...APP_NAVIGATION_ITEMS,
    ...(rollout.times && timesEnabled ? [{ label: "时事", href: "/times" }] : []),
  ];
  return (
    <div className={["app-shell", className].filter(Boolean).join(" ")}>
      <AppHeader actions={headerActions} navigationItems={resolvedNavigationItems} navigationLabel={navigationLabel} />
      <Outlet />
    </div>
  );
}
