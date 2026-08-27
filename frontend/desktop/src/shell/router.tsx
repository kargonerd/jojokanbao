import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  createBrowserRouter,
  createHashRouter,
  type RouteObject,
  useLocation,
} from 'react-router-dom';
import {
  ArchiveLayout,
  ArchiveReaderPage,
  AccountEntry,
  BookshelfPage,
  BookReaderPage,
  LibraryPage,
  PERIODICALS,
  PUBLICATIONS,
  PUBLICATION_NAMES,
  HomePage,
  AppLayout,
  APP_NAVIGATION_ITEMS,
  RagRoutes,
  SearchPage,
  SupportPage,
  defaultArchiveIssuePath,
  refreshFeatureFlags,
  rollout,
  startAccountSessionSync,
  type AppNavigationItem,
  useAccountSessionStore,
} from '@jojo/web/desktop';
import { SettingsPage } from './SettingsPage';

const coreDesktopNavigation = APP_NAVIGATION_ITEMS.filter((item) => item.href !== '/support');
const aboutDesktopNavigation = APP_NAVIGATION_ITEMS.filter((item) => item.href === '/support');
const AccountConfirmation = lazy(() => import('@jojo/web/account-confirmation'));

function DesktopRuntime() {
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);

  useEffect(() => startAccountSessionSync(), []);
  useEffect(() => {
    if (accountInitialized) void refreshFeatureFlags();
  }, [accountInitialized, userId]);
  useEffect(() => {
    if (accountInitialized) {
      window.jojoDesktop?.setFeatureAvailability?.({ rag: rollout.rag && Boolean(userId) });
    }
  }, [accountInitialized, userId]);
  return null;
}

function DesktopRuntimeLayout() {
  return <><DesktopRuntime /><Outlet /></>;
}

function useDesktopNavigation(): readonly AppNavigationItem[] {
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  return [
    ...coreDesktopNavigation,
    ...(rollout.rag && accountInitialized && userId ? [{ label: 'AI', href: '/rag', badge: 'Beta' }] : []),
    ...aboutDesktopNavigation,
  ];
}

function DesktopSettingsAction() {
  const { pathname } = useLocation();
  return (
    <Link
      aria-label="设置"
      className={`desktop-header-setting${pathname === '/settings' ? ' is-active' : ''}`}
      title="设置 (Ctrl+,)"
      to="/settings"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="adjustments">
        <path d="M4 8h10m4 0h2M4 16h2m4 0h10" />
        <circle cx="16" cy="8" r="2" />
        <circle cx="8" cy="16" r="2" />
      </svg>
    </Link>
  );
}

function DesktopAppLayout({ children, showHeader = true }: { children?: ReactNode; showHeader?: boolean } = {}) {
  return (
    <AppLayout
      className="desktop-shell"
      headerActions={<DesktopSettingsAction />}
      navigationItems={useDesktopNavigation()}
      showHeader={showHeader}
    >
      {children}
    </AppLayout>
  );
}

function DesktopAccountRoute() {
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  return (
    <DesktopAppLayout showHeader={accountInitialized && Boolean(userId)}>
      <AccountEntry />
    </DesktopAppLayout>
  );
}

function DesktopArchiveLayout() {
  return (
    <ArchiveLayout
      className="desktop-shell"
      headerActions={<DesktopSettingsAction />}
      navigationItems={useDesktopNavigation()}
      platformRedesign
    />
  );
}

function ServiceMessage({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <main className="desktop-service-message">
      <p>{eyebrow}</p>
      <h1>{title}</h1>
      <div>{children}</div>
      <Link to="/">返回今日阅读</Link>
    </main>
  );
}

function NotFound() {
  return (
    <ServiceMessage eyebrow="404" title="没有找到这个页面">
      <p>地址可能已经变更。返回首页后可以从顶部导航重新选择功能。</p>
    </ServiceMessage>
  );
}

function AuthenticatedRoute({ children }: { children: ReactNode }) {
  const initialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const location = useLocation();
  if (!initialized) {
    return (
      <ServiceMessage eyebrow="JOJO" title="正在检查功能权限">
        <p>正在读取这台设备可使用的功能。</p>
      </ServiceMessage>
    );
  }
  if (!userId) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/account?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return children;
}

export function createDesktopRoutes(): RouteObject[] {
  const archiveReaderRoutes: RouteObject[] = PUBLICATION_NAMES.flatMap((name) => [
    { path: name, element: <Navigate to={defaultArchiveIssuePath(name)} replace /> },
    {
      path: `${name}/:id`,
      element: <ArchiveReaderPage name={name} type={PUBLICATIONS[name].type} />,
    },
  ]);
  return [
    {
      path: '/',
      element: <DesktopRuntimeLayout />,
      children: [
        {
          element: <DesktopAppLayout />,
          children: [
            { index: true, element: <HomePage periodicals={PERIODICALS} /> },
            { path: 'bookshelf', element: <BookshelfPage /> },
            { path: 'library', element: <LibraryPage periodicals={PERIODICALS} /> },
            { path: 'library/:datasetId', element: <LibraryPage periodicals={PERIODICALS} /> },
            {
              path: 'search',
              element: <div className="h-[calc(100vh-64px)] overflow-hidden"><SearchPage openResultsInNewTab={false} platformRedesign /></div>,
            },
            { path: 'support', element: <SupportPage platformRedesign /> },
            { path: 'settings', element: <SettingsPage /> },
            ...(rollout.rag
              ? [{ path: 'rag/*', element: <AuthenticatedRoute><RagRoutes /></AuthenticatedRoute> }]
              : []),
          ],
        },
        {
          path: 'archive',
          element: <DesktopArchiveLayout />,
          children: [
            { index: true, element: <Navigate to="/library?type=periodical" replace /> },
            ...archiveReaderRoutes,
          ],
        },
        { path: 'book/:notebookId/:sourceId', element: <BookReaderPage /> },
        { path: 'account', element: <DesktopAccountRoute /> },
        {
          path: 'account/confirm',
          element: (
            <Suspense fallback={<main className="min-h-screen bg-paper" aria-label="正在载入账号确认页面" />}>
              <AccountConfirmation />
            </Suspense>
          ),
        },
        { path: 'login', element: <Navigate to="/account" replace /> },
        { path: '*', element: <NotFound /> },
      ],
    },
  ];
}

export function createDesktopRouter() {
  const routes = createDesktopRoutes();
  return window.location.protocol === 'file:'
    ? createHashRouter(routes)
    : createBrowserRouter(routes);
}
