import { useEffect, useState } from 'react';

export function UpdateNotice() {
  const [state, setState] = useState<DesktopUpdateState>();
  const [dismissedVersion, setDismissedVersion] = useState<string>();

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
