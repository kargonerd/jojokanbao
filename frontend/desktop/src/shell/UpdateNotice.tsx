import { useEffect, useRef, useState } from 'react';
import { analytics } from '@jojo/analytics';

export function UpdateNotice() {
  const [state, setState] = useState<DesktopUpdateState>();
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const reported = useRef(new Set<string>());

  useEffect(() => {
    if (!state) return;
    const event = state.phase === 'available' ? 'update_available'
      : state.phase === 'downloaded' ? 'update_downloaded'
      : state.phase === 'error' ? 'update_failed' : undefined;
    const key = `${event}:${state.availableVersion ?? ''}`;
    if (event && !reported.current.has(key)) {
      reported.current.add(key);
      analytics.track(event, { available_version: state.availableVersion ?? 'unknown' });
    }
  }, [state]);

  useEffect(() => {
    const updates = window.jojoDesktop?.updates;
    if (!updates) return;
    void updates.getState().then(setState).catch(() => undefined);
    return updates.onState(setState);
  }, []);

  if (state?.phase !== 'downloaded' || state.availableVersion === dismissedVersion) return null;
  return (
    <aside className="desktop-update-notice" aria-live="polite" aria-label="应用更新已就绪">
      <div>
        <strong>新版本 {state.availableVersion} 已就绪</strong>
        <span>重启 JOJO 看报后即可完成更新。</span>
      </div>
      <button type="button" onClick={() => setDismissedVersion(state.availableVersion)}>稍后</button>
      <button className="is-primary" type="button" onClick={() => void window.jojoDesktop?.updates?.install()}>重启安装</button>
    </aside>
  );
}
