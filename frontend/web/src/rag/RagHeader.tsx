import { Link } from "react-router-dom";
import { AccountMenu } from "../account/AccountMenu";
import { ARCHIVE_ROOT } from "../routes";
import { rollout } from "../rollout";

export function RagHeader() {
  const libraryHref = typeof window !== "undefined" && "jojoDesktop" in window ? "/library" : ARCHIVE_ROOT;
  return (
    <div className="flex h-14 items-center gap-5 border-b border-rule-dark bg-paper px-5">
      <Link to="/rag" className="font-bold tracking-[0.14em] text-red">JOJO问答</Link>
      <nav className="ml-auto flex items-center gap-4 text-sm">
        <Link to={libraryHref} className="font-bold text-ink hover:text-red">资料库</Link>
        {rollout.times && <Link to="/times" className="font-bold text-ink hover:text-red">时事</Link>}
      </nav>
      {rollout.platformRedesign && <AccountMenu />}
    </div>
  );
}
