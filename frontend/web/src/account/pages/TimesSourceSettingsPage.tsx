import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { TimesSourceRef } from "@jojo/content";
import { timesApi } from "../../times/api";
import { SourceLogo } from "../../times/components/SourceLogo";
import { useTimesPreferencesStore } from "../../times/preferencesStore";
import { timesSourceName } from "../../times/sourceNames";

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

export function TimesSourceSettingsPage() {
  const [sources, setSources] = useState<TimesSourceRef[]>([]);
  const [error, setError] = useState("");
  const disabledSourceIds = useTimesPreferencesStore((state) => state.disabledSourceIds);
  const setSourceEnabled = useTimesPreferencesStore((state) => state.setSourceEnabled);
  const setAllSourcesEnabled = useTimesPreferencesStore((state) => state.setAllSourcesEnabled);
  const enableAllSources = useTimesPreferencesStore((state) => state.enableAllSources);
  const disabled = useMemo(() => new Set(disabledSourceIds), [disabledSourceIds]);
  const sourceIds = useMemo(() => sources.map((source) => source.id), [sources]);
  const enabledCount = sources.filter((source) => !disabled.has(source.id)).length;
  const allEnabled = Boolean(sources.length) && enabledCount === sources.length;

  useEffect(() => {
    let active = true;
    void timesApi.timelineIndex()
      .then((index) => {
        if (active) setSources(index.sources);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "媒体列表暂时无法载入");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (sources.length && enabledCount === 0) enableAllSources();
  }, [enableAllSources, enabledCount, sources.length]);

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] px-5 text-ink sm:px-8">
      <article className="mx-auto w-full max-w-[46rem] py-6 sm:py-7">
        <Link to="/account" className="font-sans text-xs font-black text-red hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red">← 返回账号</Link>
        <header className="mt-4 border-b border-ink pb-4">
          <p className="m-0 font-sans text-[10px] font-black tracking-[0.16em] text-red">阅读偏好</p>
          <h1 className="mb-0 mt-1.5 font-serif text-2xl font-black text-ink">时事媒体源</h1>
          <p className="mb-0 mt-1.5 text-sm font-bold leading-6 text-muted">关闭不想出现在时事时间线中的媒体，至少保留一个。</p>
        </header>

        {error ? <p role="alert" className="mt-5 border-l-4 border-red bg-[#fbf3f3] px-4 py-3 text-sm font-bold text-red">{error}</p> : null}
        {!error && !sources.length ? <p className="py-10 text-sm font-bold text-muted">正在载入媒体列表…</p> : null}
        {sources.length ? (
          <section aria-label="时事媒体源" className="divide-y divide-rule border-b border-rule">
            <div className="flex items-center gap-3 bg-[color-mix(in_srgb,var(--color-red)_4%,var(--app-canvas))] px-3 py-3">
              <span aria-hidden="true" className="grid h-6 w-6 shrink-0 grid-cols-2 gap-[2px] text-red">
                <i className="border border-current" /><i className="border border-current" /><i className="border border-current" /><i className="border border-current" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="m-0 font-sans text-sm font-black text-ink">全部媒体</h2>
                <p className="mb-0 mt-0.5 font-sans text-[10px] font-bold text-muted">{allEnabled ? "所有来源均显示" : `已开启 ${enabledCount} / ${sources.length} 个`}</p>
              </div>
              <SourceSwitch
                enabled={allEnabled}
                label={`${allEnabled ? "关闭" : "开启"}全部媒体`}
                disabled={sources.length <= 1}
                title={allEnabled ? `关闭后仅保留 ${timesSourceName(sources[0]!)}` : "开启所有媒体"}
                onClick={() => setAllSourcesEnabled(!allEnabled, sourceIds)}
              />
            </div>
            {sources.map((source) => {
              const enabled = !disabled.has(source.id);
              const lastEnabled = enabled && enabledCount === 1;
              return (
                <div key={source.id} className="flex items-center gap-3 px-3 py-2.5">
                  <SourceLogo source={source} size="rail" />
                  <div className="min-w-0 flex-1">
                    <h2 className="m-0 truncate font-sans text-sm font-black text-ink">{timesSourceName(source)}</h2>
                    <p className="mb-0 mt-0.5 font-sans text-[9px] font-bold tracking-[0.08em] text-muted">{source.language === "zh-CN" ? "中文" : "外文"}</p>
                  </div>
                  <SourceSwitch
                    enabled={enabled}
                    label={`${enabled ? "关闭" : "开启"}${timesSourceName(source)}`}
                    disabled={lastEnabled}
                    title={lastEnabled ? "至少保留一个媒体" : undefined}
                    onClick={() => setSourceEnabled(source.id, !enabled, sourceIds)}
                  />
                </div>
              );
            })}
          </section>
        ) : null}
      </article>
    </main>
  );
}
