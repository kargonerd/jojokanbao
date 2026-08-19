import { Link, useLocation } from "react-router-dom";
import { PlatformAccountMenu } from "./PlatformAccountMenu";

const navItems = [
  { label: "首页", href: "/" },
  { label: "资料库", href: "/library" },
  { label: "搜索", href: "/search" },
  { label: "关于", href: "/support" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PlatformHeader() {
  const { pathname } = useLocation();

  return (
    <header className="platform-header">
      <Link className="platform-brand" to="/" aria-label="JOJO 看报首页">
        <img className="platform-brand-full" src="/brand/jojo-kanbao-logo.png" alt="" />
        <img className="platform-brand-mark" src="/brand/jojo-kanbao-mark.png" alt="" />
      </Link>
      <nav aria-label="主导航">
        {navItems.map((item) => (
          <Link
            key={item.href}
            to={item.href}
            className={isActive(pathname, item.href) ? "is-active" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <PlatformAccountMenu />
    </header>
  );
}
