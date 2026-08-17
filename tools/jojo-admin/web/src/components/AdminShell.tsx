import { NavLink, Outlet } from "react-router-dom";

const items = [
  { to: "/", label: "总览", note: "Overview", end: true },
  { to: "/pdf", label: "PDF 数据", note: "导入与发布" },
  { to: "/content", label: "书籍内容", note: "JSON 与 Jox" },
  { to: "/es", label: "ES 数据", note: "搜索与修复" },
  { to: "/features", label: "功能开关", note: "灰度与规则" },
  { to: "/agent", label: "Agent 管理", note: "凭据与连接" },
];

export function AdminShell() {
  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <NavLink className="admin-brand" to="/">
          <span className="brand-mark">J</span>
          <span>
            <b>JOJO 看报</b>
            <small>管理台</small>
          </span>
        </NavLink>
        <nav aria-label="管理台导航">
          {items.map((item) => (
            <NavLink
              key={item.to}
              end={item.end}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
              to={item.to}
            >
              <span>{item.label}</span>
              <small>{item.note}</small>
            </NavLink>
          ))}
        </nav>
        <div className="operator">
          <i />
          CONTROL ENVIRONMENT
        </div>
      </aside>
      <section className="admin-content">
        <Outlet />
      </section>
    </div>
  );
}
