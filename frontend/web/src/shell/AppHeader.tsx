import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { AccountMenu } from "../account/AccountMenu";

export type AppNavigationItem = {
  label: string;
  href: string;
  badge?: string;
};

export const APP_NAVIGATION_ITEMS = [
  { label: "首页", href: "/" },
  { label: "资料库", href: "/library" },
  { label: "搜索", href: "/search" },
  { label: "关于", href: "/support" },
] as const satisfies readonly AppNavigationItem[];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader({
  navigationItems = APP_NAVIGATION_ITEMS,
  navigationLabel = "主导航",
  actions,
}: {
  navigationItems?: readonly AppNavigationItem[];
  navigationLabel?: string;
  actions?: ReactNode;
} = {}) {
  const { pathname } = useLocation();
  const brandBase = import.meta.env.BASE_URL;

  return (
    <header className="app-header">
      <Link className="app-brand" to="/" aria-label="JOJO 看报首页">
        <img className="app-brand-full" src={`${brandBase}brand/jojo-kanbao-logo.png`} alt="" />
        <img className="app-brand-mark" src={`${brandBase}brand/jojo-kanbao-mark.png`} alt="" />
      </Link>
      <nav aria-label={navigationLabel}>
        {navigationItems.map((item) => (
          <Link
            key={item.href}
            to={item.href}
            className={isActive(pathname, item.href) ? "is-active" : undefined}
          >
            <span className="app-navigation-label">
              {item.label}
              {item.badge ? <span className="app-navigation-badge">{item.badge}</span> : null}
            </span>
          </Link>
        ))}
      </nav>
      <div className="app-header-actions">
        {actions}
        <AccountMenu />
      </div>
    </header>
  );
}
