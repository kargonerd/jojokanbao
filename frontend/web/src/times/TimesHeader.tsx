import { Link } from "react-router-dom";
import { AccountMenu } from "../account/AccountMenu";
import { ARCHIVE_ROOT } from "../routes";
import { rollout } from "../rollout";

export function TimesHeader() {
  const libraryHref = typeof window !== "undefined" && "jojoDesktop" in window ? "/library" : ARCHIVE_ROOT;
  return (
    <header className="border-b-2 border-rule-dark bg-paper px-5 py-4 md:px-8">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-5">
        <Link to="/times" className="text-xl font-bold tracking-[0.18em] text-red">JOJO TIMES</Link>
        <p className="m-0 hidden text-xs font-bold tracking-[0.18em] text-muted md:block">AI 辅助阅读新闻</p>
        <nav className="ml-auto flex flex-wrap items-center gap-4 text-sm">
          <Link to={libraryHref} className="font-bold text-ink hover:text-red">资料库</Link>
          {rollout.rag && <Link to="/rag" className="font-bold text-ink hover:text-red">问答</Link>}
        </nav>
        {rollout.platformRedesign && <AccountMenu />}
      </div>
    </header>
  );
}
