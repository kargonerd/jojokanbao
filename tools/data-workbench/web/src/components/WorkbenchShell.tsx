import { NavLink, Outlet } from "react-router-dom";

const items = [
  { to: "/", label: "总览", note: "Overview", end: true },
  { to: "/pdf", label: "PDF 数据", note: "导入与发布" },
  { to: "/content", label: "书籍内容", note: "JSON 与 Jox" },
  { to: "/es", label: "ES 数据", note: "搜索与修复" },
];

export function WorkbenchShell() {
  return (
    <div className="workbench-shell">
      <aside className="workbench-nav">
        <NavLink className="workbench-brand" to="/">
          <span className="brand-mark">J</span>
          <span>
            <b>JOJO 看报</b>
            <small>数据工作台</small>
          </span>
        </NavLink>
        <nav aria-label="工作台导航">
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
          LOCAL OPERATOR
        </div>
      </aside>
      <section className="workbench-content">
        <Outlet />
      </section>
    </div>
  );
}
