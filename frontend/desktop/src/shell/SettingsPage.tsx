import { useEffect, useState } from 'react';

type AppInfo = { version: string; platform: string; arch: string };
type CloseBehavior = 'ask' | 'tray' | 'quit';

const closeBehaviorOptions: Array<{
  value: CloseBehavior;
  label: string;
  description: string;
}> = [
  { value: 'ask', label: '每次询问', description: '关闭时让我选择' },
  { value: 'tray', label: '最小化到系统托盘', description: '应用继续在后台运行' },
  { value: 'quit', label: '直接退出应用', description: '完全关闭 JOJO看报' },
];

export function SettingsPage() {
  const launchAtLoginSupported = window.jojoDesktop?.platform !== 'linux';
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('ask');
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [closeBusy, setCloseBusy] = useState(true);
  const [launchBusy, setLaunchBusy] = useState(true);
  const [closeMessage, setCloseMessage] = useState('');
  const [launchMessage, setLaunchMessage] = useState('');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState>();

  useEffect(() => {
    const settings = window.jojoDesktop?.settings;
    void Promise.all([
      settings?.getCloseBehavior() ?? Promise.resolve<CloseBehavior>('ask'),
      launchAtLoginSupported ? settings?.getLaunchAtLogin?.() ?? Promise.resolve(false) : Promise.resolve(false),
      window.jojoDesktop?.getAppInfo?.() ?? Promise.resolve(null),
    ])
      .then(([behavior, launchEnabled, info]) => {
        setCloseBehavior(behavior);
        setLaunchAtLogin(launchEnabled);
        setAppInfo(info);
      })
      .catch(() => {
        setCloseMessage('无法读取本机设置。');
        setLaunchMessage('无法读取本机设置。');
      })
      .finally(() => {
        setCloseBusy(false);
        setLaunchBusy(false);
      });
  }, [launchAtLoginSupported]);

  useEffect(() => {
    const updates = window.jojoDesktop?.updates;
    if (!updates) return;
    void updates.getState().then(setUpdateState).catch(() => undefined);
    return updates.onState(setUpdateState);
  }, []);

  const updateCloseBehavior = async (value: CloseBehavior) => {
    const settings = window.jojoDesktop?.settings;
    if (!settings) {
      setCloseMessage('设置只能在 JOJO 桌面应用中保存。');
      return;
    }
    const previous = closeBehavior;
    setCloseBehavior(value);
    setCloseBusy(true);
    setCloseMessage('');
    try {
      await settings.saveCloseBehavior(value);
      setCloseMessage('已保存');
    } catch {
      setCloseBehavior(previous);
      setCloseMessage('保存失败，请重试。');
    } finally {
      setCloseBusy(false);
    }
  };

  const updateLaunchAtLogin = async (value: boolean) => {
    const settings = window.jojoDesktop?.settings;
    if (!settings?.saveLaunchAtLogin) {
      setLaunchMessage('设置只能在 JOJO 桌面应用中保存。');
      return;
    }
    const previous = launchAtLogin;
    setLaunchAtLogin(value);
    setLaunchBusy(true);
    setLaunchMessage('');
    try {
      const saved = await settings.saveLaunchAtLogin(value);
      setLaunchAtLogin(saved);
      setLaunchMessage('已保存');
    } catch {
      setLaunchAtLogin(previous);
      setLaunchMessage('保存失败，请重试。');
    } finally {
      setLaunchBusy(false);
    }
  };

  const closeBehaviorDescription = closeBehaviorOptions.find((option) => option.value === closeBehavior)?.description;

  return (
    <main className="desktop-settings">
      <header className="desktop-page-heading">
        <p>桌面偏好</p>
        <h1>设置</h1>
        <span>设置只保存在这台电脑。</span>
      </header>

      <section className="desktop-preference-list" aria-label="桌面设置">
        <div className="desktop-preference-row">
          <div className="desktop-preference-copy">
            <label htmlFor="close-behavior">关闭窗口时</label>
            <small>{closeBehaviorDescription}</small>
          </div>
          <div className="desktop-preference-control">
            <select
              id="close-behavior"
              aria-label="关闭窗口时"
              disabled={closeBusy}
              onChange={(event) => void updateCloseBehavior(event.target.value as CloseBehavior)}
              value={closeBehavior}
            >
              {closeBehaviorOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <output aria-live="polite">{closeMessage}</output>
          </div>
        </div>

        {launchAtLoginSupported ? (
          <label className="desktop-preference-row desktop-preference-toggle">
            <span className="desktop-preference-copy">
              <strong>开机时启动</strong>
              <small>登录电脑后自动打开 JOJO看报</small>
            </span>
            <span className="desktop-preference-control">
              <input
                aria-label="开机时启动"
                checked={launchAtLogin}
                disabled={launchBusy}
                onChange={(event) => void updateLaunchAtLogin(event.target.checked)}
                type="checkbox"
              />
              <output aria-live="polite">{launchMessage}</output>
            </span>
          </label>
        ) : null}
      </section>

      <section className="desktop-preference-list desktop-update-preference" aria-label="应用更新">
        <div className="desktop-preference-row">
          <div className="desktop-preference-copy">
            <strong>应用更新</strong>
            <small>{updateState?.message ?? '正在读取更新状态…'}</small>
          </div>
          <div className="desktop-preference-control">
            {updateState?.phase === 'downloaded' ? (
              <button type="button" onClick={() => void window.jojoDesktop?.updates?.install()}>重启安装</button>
            ) : (
              <button
                type="button"
                disabled={!updateState?.supported || updateState.phase === 'checking' || updateState.phase === 'downloading'}
                onClick={() => void window.jojoDesktop?.updates?.check()}
              >
                {updateState?.phase === 'checking' ? '检查中…' : updateState?.phase === 'downloading' ? `下载 ${updateState.progress ?? 0}%` : '检查更新'}
              </button>
            )}
          </div>
        </div>
      </section>

      <footer className="desktop-settings-about" aria-label="关于 JOJO看报">
        <span>JOJO看报</span>
        <span>版本 {appInfo?.version ?? '开发预览'}</span>
        <span>{appInfo ? `${appInfo.platform} · ${appInfo.arch}` : '浏览器预览'}</span>
      </footer>
    </main>
  );
}
