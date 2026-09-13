import { LIBRARY_SOURCES, isLibrarySourceEnabled } from "@jojo/content";
import { Link } from "react-router-dom";
import { useLibraryPreferencesStore } from "./preferencesStore";

function SourceSwitch({
  enabled,
  label,
  disabled = false,
  title,
  onClick,
}: {
  enabled: boolean;
  label: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`relative h-6 w-10 shrink-0 border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-not-allowed disabled:opacity-55 ${enabled ? "border-red bg-red" : "border-rule-dark bg-paper"}`}
    >
      <span aria-hidden="true" className={`absolute top-[3px] h-4 w-4 bg-paper transition-transform ${enabled ? "left-[20px]" : "left-[3px] border border-rule-dark"}`} />
    </button>
  );
}

export function LibrarySettingsPage({ backTo = "/account" }: { backTo?: string }) {
  const { enabledSources, setSourceEnabled } = useLibraryPreferencesStore();
  const backLabel = backTo === "/account" ? "← 返回账号" : "← 返回设置";

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] px-5 text-ink sm:px-8">
      <article className="mx-auto w-full max-w-[46rem] py-6 sm:py-7">
        <Link
          to={backTo}
          className="font-sans text-xs font-black text-red hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red"
        >
          {backLabel}
        </Link>
        <header className="mt-4 border-b border-ink pb-4">
          <p className="m-0 font-sans text-[10px] font-black tracking-[0.16em] text-red">阅读偏好</p>
          <h1 className="mb-0 mt-1.5 font-serif text-2xl font-black text-ink">资料库设置</h1>
          <p className="mb-0 mt-1.5 text-sm font-bold leading-6 text-muted">
            JOJO书库始终开启。你可以选择是否开启共享书库；关闭后，相关书籍会从资料库、书架和问答范围中隐藏，阅读记录与下载会保留。
          </p>
        </header>

        <section aria-label="资料库设置" className="divide-y divide-rule border-b border-rule">
          {LIBRARY_SOURCES.map((source) => {
            const fixed = source.id === "jojo";
            const enabled = isLibrarySourceEnabled(source.id, enabledSources);
            return (
              <div key={source.id} className="flex items-center justify-between gap-5 py-4">
                <div>
                  <h2 className="m-0 font-serif text-base font-black text-ink">{source.title}</h2>
                  <p className="mb-0 mt-1 text-xs font-bold leading-6 text-muted">{source.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-sans text-xs font-bold text-muted">
                    {fixed ? "始终开启" : enabled ? "已开启" : "已关闭"}
                  </span>
                  <SourceSwitch
                    enabled={enabled}
                    label={source.title}
                    disabled={fixed}
                    title={fixed ? "JOJO书库始终开启" : undefined}
                    onClick={() => setSourceEnabled(source.id, !enabled)}
                  />
                </div>
              </div>
            );
          })}
        </section>
      </article>
    </main>
  );
}
