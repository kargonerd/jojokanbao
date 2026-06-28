import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { AppShell, NavBar, type NavItem } from "@jojo/ui";

const navItems: NavItem[] = [
  { label: "首页", href: "/" },
  { label: "报纸", children: [
    { label: "人民日报", href: "/rmrb/19761009" },
    { label: "参考消息", href: "/ckxx/19760910" },
  ]},
  { label: "杂志", children: [
    { label: "红旗", href: "/hq/196419" },
    { label: "人民画报", href: "/rmhb/197292" },
    { label: "世界知识", href: "/sjzs/196513" },
  ]},
  { label: "搜索", href: "/search" },
  { label: "反馈", href: "/support" },
];

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <AppShell
      header={
        <NavBar
          items={navItems}
          mobileTitle="JOJO看报"
          onNavigate={(href) => navigate(href)}
          isActive={(href) => location.pathname === href || location.pathname.startsWith(href + "/")}
          trailing={<p className="text-[13px] italic font-bold text-red opacity-80 tracking-wider truncate max-w-[44vw] m-0">如果要看前途，一定要看历史 —— 毛泽东</p>}
        />
      }
      contentClassName="overflow-hidden"
    >
      <Outlet />
    </AppShell>
  );
}
