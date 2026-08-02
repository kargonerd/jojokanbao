import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

export function SettingsPage() {
  const [token, setToken] = useState('');
  const [configured, setConfigured] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void window.jojoDesktop?.settings?.getMineru().then((result) => {
      setConfigured(result.configured);
    });
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const settings = window.jojoDesktop?.settings;
    if (!settings) {
      setMessage('设置只能在 JOJO 桌面应用中保存');
      return;
    }
    try {
      const result = await settings.saveMineru(token);
      setConfigured(result.configured);
      setToken('');
      setMessage(result.configured ? 'API Key 已安全保存' : 'API Key 已清除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    }
  };

  return (
    <main className="desktop-settings">
      <p>JOJO DESKTOP</p>
      <h1>设置</h1>
      <form onSubmit={(event) => void save(event)}>
        <label htmlFor="mineru-token">MinerU API Key</label>
        <span>
          {configured ? '已配置。输入新 Key 可替换，留空保存可清除。' : '请在 MinerU 官网申请后填入。'}
        </span>
        <input
          id="mineru-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">{token ? '保存 API Key' : configured ? '清除 API Key' : '保存'}</button>
        {message ? <output>{message}</output> : null}
      </form>
      <a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">前往 MinerU 申请 API Key</a>
      <Link to="/">返回工作台</Link>
    </main>
  );
}
