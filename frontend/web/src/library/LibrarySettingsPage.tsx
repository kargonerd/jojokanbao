import { LIBRARY_SOURCES } from "@jojo/content";
import { Link } from "react-router-dom";
import { useLibraryPreferencesStore } from "./preferencesStore";

export function LibrarySettingsPage({ backTo = "/account" }: { backTo?: string }) {
  const { enabledSources, setSourceEnabled } = useLibraryPreferencesStore();
  return <main className="mx-auto w-full max-w-3xl px-6 py-8 sm:py-12">
    <Link to={backTo} className="text-sm text-red">← 返回设置</Link>
    <h1 className="mb-3 mt-8 font-serif text-3xl">资料库设置</h1>
    <p className="mb-8 text-sm leading-7 text-muted">选择本设备显示的书源。关闭后，相关书籍会从资料库、书架和问答范围中隐藏，阅读记录与下载会保留。</p>
    <div className="border-t border-rule">
      {LIBRARY_SOURCES.map((source) => {
        const enabled = enabledSources.includes(source.id);
        return <div key={source.id} className="flex items-center justify-between gap-6 border-b border-rule py-6">
          <div><h2 className="m-0 font-serif text-lg">{source.title}</h2><p className="mb-0 mt-2 text-sm leading-6 text-muted">{source.description}</p></div>
          <button type="button" role="switch" aria-label={source.title} aria-checked={enabled}
            onClick={() => setSourceEnabled(source.id, !enabled)}
            className={`shrink-0 border px-4 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-red ${enabled ? "border-red bg-red text-white" : "border-rule bg-paper text-muted"}`}>
            {enabled ? "已开启" : "已关闭"}
          </button>
        </div>;
      })}
    </div>
  </main>;
}
