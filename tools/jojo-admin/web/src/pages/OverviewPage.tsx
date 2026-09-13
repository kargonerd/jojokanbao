import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageTopbar } from "../components/PageTopbar";
import { adminNavigation, NavigationIcon } from "../components/navigation";
import { useAdminSession } from "../auth/session";
import { apiGet } from "../lib/api";

export function OverviewPage() {
  const user = useAdminSession((state) => state.user);
  const items = adminNavigation.filter((item) => user?.permissions.includes(item.permission));
  const [search, setSearch] = useState("");
  const [esState, setEsState] = useState("正在检查搜索服务…");
  const canOperate = user?.permissions.includes("operations");
  useEffect(() => {
    if (!canOperate) return;
    let active = true;
    apiGet<{ success: boolean; activeDocuments: number }>("/api/es-repair/status")
      .then((data) => { if (active) setEsState(`搜索服务已连接，${data.activeDocuments.toLocaleString("zh-CN")} 条有效文档`); })
      .catch(() => { if (active) setEsState("搜索服务连接失败，请在搜索数据页面检查"); });
    return () => { active = false; };
  }, [canOperate]);
  return <>
    <PageTopbar title="工作台" description="整理内容，维护读者的阅读体验。" aside={<time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date())}</time>} />
    <main className="overview">
      <section className="admin-directory" aria-labelledby="admin-directory-title">
        <header><h2 id="admin-directory-title">开始工作</h2><label className="admin-module-search"><NavigationIcon name="search" /><input type="search" aria-label="查找管理功能" placeholder="查找管理功能" value={search} onChange={(event) => setSearch(event.target.value)} /></label></header>
        <div className="admin-module-list">
          {items.filter((item) => `${item.label}${item.description}`.includes(search.trim())).map((item) => <Link className="admin-module" key={item.to} to={item.to}>
            <NavigationIcon name={item.icon} /><div><h3>{item.label}</h3><p>{item.description}</p></div><span className="admin-module-open">打开</span>
          </Link>)}
          {!items.some((item) => `${item.label}${item.description}`.includes(search.trim())) && <p className="admin-empty">没有匹配的功能，试试其他关键词。</p>}
        </div>
      </section>
      {canOperate && <section className="admin-connections" aria-label="运行状态"><h2>运行状态</h2><p>{esState}</p><a href="https://us.posthog.com/project/604535/dashboard/2087269" target="_blank" rel="noreferrer">查看使用统计与错误</a><a href="https://us.posthog.com/project/604535/feature_flags" target="_blank" rel="noreferrer">管理运行配置</a></section>}
    </main>
  </>;
}
