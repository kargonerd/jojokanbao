import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePlatformAccountStore } from "./accountSession";

export type PlatformNavigationItem = {
  label: string;
  href: string;
};

export const PLATFORM_NAVIGATION_ITEMS = [
  { label: "首页", href: "/" },
  { label: "资料库", href: "/library" },
  { label: "搜索", href: "/search" },
  { label: "关于", href: "/support" },
] as const satisfies readonly PlatformNavigationItem[];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PlatformHeader({
  navigationItems = PLATFORM_NAVIGATION_ITEMS,
  navigationLabel = "主导航",
  actions,
}: {
  navigationItems?: readonly PlatformNavigationItem[];
  navigationLabel?: string;
  actions?: ReactNode;
} = {}) {
  const { pathname } = useLocation();
  const userId = usePlatformAccountStore((state) => state.userId);
  const displayName = usePlatformAccountStore((state) => state.displayName);
  const brandBase = import.meta.env.BASE_URL;

  return (
    <header className="platform-header">
      <Link className="platform-brand" to="/" aria-label="JOJO 看报首页">
        <img className="platform-brand-full" src={`${brandBase}brand/jojo-kanbao-logo.png`} alt="" />
        <img className="platform-brand-mark" src={`${brandBase}brand/jojo-kanbao-mark.png`} alt="" />
      </Link>
      <nav aria-label={navigationLabel}>
        {navigationItems.map((item) => (
          <Link
            key={item.href}
            to={item.href}
            className={isActive(pathname, item.href) ? "is-active" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="platform-header-actions">
        {actions}
        <Link className="platform-login" to="/account">{userId ? displayName || "账号" : "登录"}</Link>
      </div>
    </header>
  );
}
