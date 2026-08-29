import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AccountMenu } from "../account/AccountMenu";
import { useAccountSessionStore } from "../account/session";

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

const MOBILE_PRIMARY_HREFS = new Set(["/", "/library", "/search", "/rag", "/times"]);

function mobilePageTitle(pathname: string, navigationItems: readonly AppNavigationItem[]): string {
  const activeItem = navigationItems.find((item) => isActive(pathname, item.href));
  if (activeItem) return activeItem.label;
  if (pathname.startsWith("/archive/")) return "阅读";
  if (pathname.startsWith("/bookshelf")) return "我的书架";
  if (pathname.startsWith("/notifications")) return "通知";
  if (pathname.startsWith("/account")) return "账号";
  return "JOJO 看报";
}

function hidesMobileNavigation(pathname: string): boolean {
  return /^\/times\/[^/]+\/[^/]+/.test(pathname)
    || /^\/archive\/[^/]+\/[^/]+/.test(pathname)
    || pathname.startsWith("/book/");
}

function isPrimaryMobilePage(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/library"
    || pathname === "/search"
    || pathname === "/times"
    || pathname === "/rag"
    || pathname === "/rag/chat";
}

function MobileNavigationIcon({ href }: { href: string }) {
  if (href === "/") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 10 8-7 8 7v10h-6v-6h-4v6H4z" /></svg>;
  if (href === "/library") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h5v16H4zM11 4h4v16h-4zM17 5l3-1 3 15-3 1z" /></svg>;
  if (href === "/search") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>;
  if (href === "/rag") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5zM18.5 16l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM7 8h6v4H7zM15 8h2M15 11h2M7 15h10" /></svg>;
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
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname } = location;
  const brandBase = import.meta.env.BASE_URL;
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const authenticated = accountInitialized && Boolean(userId);
  const mobileNavigationItems = navigationItems.filter((item) =>
    MOBILE_PRIMARY_HREFS.has(item.href) && (authenticated || (item.href !== "/rag" && item.href !== "/times")),
  );
  const mobileTitle = mobilePageTitle(pathname, navigationItems);
  const mobileTitleBadge = navigationItems.find((item) => isActive(pathname, item.href))?.badge;
  const showMobileNavigation = !hidesMobileNavigation(pathname);
  const showMobileBack = !isPrimaryMobilePage(pathname);

  const navigateBack = () => {
    if (location.key !== "default" && window.history.length > 1) navigate(-1);
    else navigate("/", { replace: true });
  };

  return <>
    <header className={`app-header${showMobileBack ? " has-mobile-back" : ""}`}>
      <Link className="app-brand" to="/" aria-label="JOJO 看报首页">
        <img className="app-brand-full" src={`${brandBase}brand/jojo-kanbao-logo.png`} alt="" />
        <img className="app-brand-mark" src={`${brandBase}brand/jojo-kanbao-mark.png`} alt="" />
      </Link>
      {showMobileBack ? <button type="button" className="app-mobile-back" onClick={navigateBack} aria-label="返回上一页">
        <span aria-hidden="true">←</span>返回
      </button> : null}
      <span className="app-mobile-title">
        {mobileTitle}
        {mobileTitleBadge ? <sup className="app-mobile-title-badge">{mobileTitleBadge}</sup> : null}
      </span>
      <nav aria-label={navigationLabel}>
        {navigationItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              to={item.href}
              className={active ? "is-active" : undefined}
            >
              <span className="app-navigation-label">
                {item.label}
                {item.badge ? <span className="app-navigation-badge">{item.badge}</span> : null}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="app-header-actions">
        {actions}
        <AccountMenu />
      </div>
    </header>
    {showMobileNavigation ? <nav className="app-mobile-navigation" aria-label="移动端导航">
      {mobileNavigationItems.map((item) => {
        const active = isActive(pathname, item.href);
        return <Link key={item.href} to={item.href} className={active ? "is-active" : undefined} aria-current={active ? "page" : undefined}>
          <MobileNavigationIcon href={item.href} />
          <span>{item.label}</span>
        </Link>;
      })}
    </nav> : null}
  </>;
}
