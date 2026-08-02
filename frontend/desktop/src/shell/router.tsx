import {
  Link,
  createBrowserRouter,
  createHashRouter,
  type RouteObject,
} from 'react-router-dom';
import { createPressRoute } from '../press/router';
import { SettingsPage } from './SettingsPage';

const modules = [
  { path: '/press', name: 'Press', description: '识别、校对并导出书刊', enabled: true, action: '进入 Press' },
  { path: '/archive', name: 'Archive', description: '报纸与杂志馆藏阅读', enabled: false },
  { path: '/account', name: 'Account', description: '账号与个人资料', enabled: false },
  { path: '/rag', name: 'RAG', description: '个人知识库与问答', enabled: false },
  { path: '/olds', name: 'Olds', description: '旧闻资料整理', enabled: false },
  { path: '/settings', name: '设置', description: '配置 MinerU 等桌面服务', enabled: true, action: '打开设置' },
] as const;

function DesktopHome() {
  return (
    <main className="desktop-home">
      <header className="desktop-home__header">
        <p>JOJO DESKTOP</p>
        <h1>工作台</h1>
        <span>桌面端能力统一从这里进入。</span>
      </header>
      <section className="desktop-module-grid" aria-label="桌面模块">
        {modules.map((module) => (
          <article className="desktop-module-card" key={module.path}>
            <p>{module.enabled ? '可使用' : '开发中'}</p>
            <h2>{module.name}</h2>
            <span>{module.description}</span>
            {module.enabled ? <Link to={module.path}>{'action' in module ? module.action : '进入'}</Link> : null}
          </article>
        ))}
      </section>
    </main>
  );
}

function ModulePlaceholder({ name }: { name: string }) {
  return (
    <main className="desktop-placeholder">
      <p>JOJO DESKTOP</p>
      <h1>{name}</h1>
      <span>模块位置已经保留，功能尚未启用。</span>
      <Link to="/">返回工作台</Link>
    </main>
  );
}

function NotFound() {
  return (
    <main className="desktop-placeholder">
      <h1>页面不存在</h1>
      <Link to="/">返回工作台</Link>
    </main>
  );
}

export function createDesktopRoutes(): RouteObject[] {
  return [
    { path: '/', element: <DesktopHome /> },
    createPressRoute(),
    { path: '/settings', element: <SettingsPage /> },
    { path: '/archive/*', element: <ModulePlaceholder name="Archive" /> },
    { path: '/account/*', element: <ModulePlaceholder name="Account" /> },
    { path: '/rag/*', element: <ModulePlaceholder name="RAG" /> },
    { path: '/olds/*', element: <ModulePlaceholder name="Olds" /> },
    { path: '*', element: <NotFound /> },
  ];
}

export function createDesktopRouter() {
  const routes = createDesktopRoutes();
  return window.location.protocol === 'file:'
    ? createHashRouter(routes)
    : createBrowserRouter(routes);
}
