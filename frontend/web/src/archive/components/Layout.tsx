import { useEffect, useState, type ReactNode } from "react";
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
    ...(!platformRedesign && rollout.rag ? [{ label: "问答", href: "/rag" }] : []),
    { label: "反馈", href: archivePath("support") },
  ];
  const [accountLabel, setAccountLabel] = useState("登录");
  const [hasReaderCode, setHasReaderCode] = useState(false);

  useEffect(() => {
    if (platformRedesign || !rollout.account) return;

    let active = true;
    let stopAuthSync = () => {};
    let unsubscribe = () => {};

    void import("../../account/auth").then(({ startAuthSync, useAuthStore }) => {
      if (!active) return;

      const updateLabel = () => {
        const { user, profile } = useAuthStore.getState();
        const displayName = profile?.display_name?.trim();
        setAccountLabel(
          user
            ? displayName || "账号"
            : "登录",
        );
        setHasReaderCode(Boolean(user && displayName));
      };

      unsubscribe = useAuthStore.subscribe(updateLabel);
      stopAuthSync = startAuthSync();
      updateLabel();
    });

    return () => {
      active = false;
      unsubscribe();
      stopAuthSync();
    };
  }, [platformRedesign]);

  if (platformRedesign) {
    return (
      <div className={["app-shell flex h-screen flex-col overflow-hidden", className].filter(Boolean).join(" ")}>
        <AppHeader actions={headerActions} navigationItems={navigationItems} />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <AppShell
      header={
        <NavBar
          items={navItems}
          actions={platformRedesign || rollout.account
            ? [{
                label: accountLabel,
                href: "/account",
                hint: hasReaderCode ? "读者" : undefined,
              }]
            : []}
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
