import { Link } from "react-router-dom";

export function Brand() {
  return (
    <Link to="/" className="group flex items-baseline gap-3 text-ink hover:text-ink" aria-label="返回 JOJO 看报">
      <span className="font-sans text-[1.65rem] font-black leading-none tracking-[-0.08em] text-red">JOJO</span>
      <span className="border-l border-rule-dark pl-3 text-sm font-bold tracking-[0.18em]">账号中心</span>
    </Link>
  );
}
