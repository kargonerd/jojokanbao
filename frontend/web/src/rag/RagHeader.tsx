import { Link } from "react-router-dom";
import { PlatformAccountMenu } from "../platform/PlatformAccountMenu";
import { ARCHIVE_ROOT } from "../routes";
import { rollout } from "../rollout";

export function RagHeader() {
  return (
    <div className="flex h-14 items-center gap-5 border-b border-rule-dark bg-paper px-5">
      <Link to="/rag" className="font-bold tracking-[0.14em] text-red">JOJO问答</Link>
      <nav className="ml-auto flex items-center gap-4 text-sm">
        <Link to={ARCHIVE_ROOT} className="font-bold text-ink hover:text-red">馆藏</Link>
        {rollout.olds && <Link to="/olds" className="font-bold text-ink hover:text-red">旧闻</Link>}
      </nav>
      {rollout.platformRedesign && <PlatformAccountMenu />}
    </div>
  );
}
