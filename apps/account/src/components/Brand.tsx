import { Link } from "react-router-dom";

export function Brand() {
  return (
    <Link to="/" className="group flex items-baseline gap-3 text-ink hover:text-ink" aria-label="JOJO 账号中心首页">
      <span className="font-sans text-[1.65rem] font-black leading-none tracking-[-0.08em] text-red">JOJO</span>
      <span className="border-l border-rule-dark pl-3 text-sm font-bold tracking-[0.18em]">账号中心</span>
    </Link>
  );
}

export function Seal({ label = "已核验" }: { label?: string }) {
  return (
    <span className="inline-flex h-16 w-16 -rotate-6 items-center justify-center border-2 border-red text-center text-[10px] font-black leading-4 tracking-[0.18em] text-red">
      JOJO<br />{label}
    </span>
  );
}
