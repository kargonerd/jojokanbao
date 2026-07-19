import { NavLink } from "react-router-dom";

function navClass(active: boolean): string {
  return `h-14 inline-flex items-center border-b-2 px-1 text-xs font-bold tracking-[0.16em] no-underline transition-colors ${
    active ? "border-red text-red" : "border-transparent text-muted hover:text-red"
  }`;
}

export function RagHeader() {
  return (
    <div className="h-full px-4 md:px-6 flex items-center justify-between bg-paper">
      <div className="flex items-baseline gap-3">
        <span className="text-lg font-black tracking-[0.18em] text-red">JOJO</span>
        <span className="hidden sm:inline text-[10px] text-muted tracking-[0.2em]">档案问答实验</span>
      </div>
      <nav className="h-full flex items-center gap-5" aria-label="主导航">
        <NavLink to="/chat" className={({ isActive }) => navClass(isActive)}>问原文</NavLink>
        <NavLink to="/documents" className={({ isActive }) => navClass(isActive)}>文档管理</NavLink>
      </nav>
    </div>
  );
}
