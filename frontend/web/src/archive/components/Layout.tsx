import type { ReactNode } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { AppShell, NavBar, type NavItem } from "@jojo/ui";
import { rollout } from "../../rollout";
import { ARCHIVE_ROOT, archivePath, defaultArchiveIssuePath } from "../../routes";
import { AppHeader, type AppNavigationItem } from "../../shell/AppHeader";

const coreNavItems: NavItem[] = [
  { label: "首页", href: ARCHIVE_ROOT },
  { label: "报纸", children: [
    { label: "人民日报", href: defaultArchiveIssuePath("rmrb") },
    { label: "参考消息", href: defaultArchiveIssuePath("ckxx") },
  ]},
  { label: "杂志", children: [
    { label: "红旗", href: defaultArchiveIssuePath("hq") },
    { label: "人民画报", href: defaultArchiveIssuePath("rmhb") },
    { label: "世界知识", href: defaultArchiveIssuePath("sjzs") },
  ]},
  { label: "搜索", href: archivePath("search") },
];

export function Layout({
  platformRedesign = rollout.platformRedesign,
  navigationItems,
  headerActions,
  className,
}: {
  platformRedesign?: boolean;
  navigationItems?: readonly AppNavigationItem[];
  headerActions?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const navItems: NavItem[] = [
    ...coreNavItems,
    { label: "反馈", href: archivePath("support") },
  ];
  if (platformRedesign) {
    return (
      <div className={["app-shell archive-shell flex flex-col overflow-hidden", className].filter(Boolean).join(" ")}>
        <AppHeader actions={headerActions} navigationItems={navigationItems} />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <AppShell
      className="archive-shell"
      header={
        <NavBar
          items={navItems}
          actions={[]}
          mobileTitle="JOJO看报"
          onNavigate={(href) => navigate(href)}
          isActive={(href) =>
            location.pathname === href ||
            (href !== ARCHIVE_ROOT && location.pathname.startsWith(href + "/"))
          }
          trailing={
            <p className="m-0 max-w-[44vw] truncate text-[13px] font-bold italic tracking-wider text-red opacity-80">
              如果要看前途，一定要看历史 —— 毛泽东
            </p>
          }
        />
      }
      contentClassName="overflow-hidden"
    >
      <Outlet />
    </AppShell>
  );
}
