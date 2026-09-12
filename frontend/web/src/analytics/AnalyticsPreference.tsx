import { useSyncExternalStore } from "react";
import { browserAnalyticsEnabled, setBrowserAnalyticsEnabled, subscribeBrowserAnalytics } from "@jojo/analytics/preferences";

export function AnalyticsPreference() {
  const enabled = useSyncExternalStore(subscribeBrowserAnalytics, browserAnalyticsEnabled, () => false);
  return (
    <label className="my-5 flex items-center justify-between gap-5 border-y border-rule py-4 text-ink">
      <span>
        <strong className="block font-serif">帮助改善 JOJO 看报</strong>
        <small className="mt-1 block font-sans text-xs leading-6 text-muted">
          分享使用次数、版本和故障信息；不收集搜索原文、批注或 AI 对话，不录制操作。设置仅对当前浏览器或客户端生效。
        </small>
      </span>
      <input type="checkbox" aria-label="帮助改善 JOJO 看报" checked={enabled}
        onChange={(event) => setBrowserAnalyticsEnabled(event.target.checked)} />
    </label>
  );
}
