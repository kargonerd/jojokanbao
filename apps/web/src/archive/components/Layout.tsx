import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { AppShell, NavBar, type NavItem } from "@jojo/ui";
import { rollout } from "../../rollout";
import { ARCHIVE_ROOT, archivePath, defaultArchiveIssuePath } from "../../routes";

const navItems: NavItem[] = [
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
  ...(rollout.olds ? [{ label: "旧闻", href: "/olds" }] : []),
  ...(rollout.rag ? [{ label: "问答", href: "/rag" }] : []),
  { label: "反馈", href: archivePath("support") },
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
          isActive={(href) =>
            location.pathname === href ||
            (href !== ARCHIVE_ROOT && location.pathname.startsWith(href + "/"))
          }
          trailing={<p className="text-[13px] italic font-bold text-red opacity-80 tracking-wider truncate max-w-[44vw] m-0">如果要看前途，一定要看历史 —— 毛泽东</p>}
        />
      }
      contentClassName="overflow-hidden"
    >
      <Outlet />
    </AppShell>
  );
}
