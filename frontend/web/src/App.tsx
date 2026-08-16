import { Fragment, lazy, Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./archive/components/Layout";
import { HomePage as ArchiveHomePage } from "./archive/pages/HomePage";
import { SearchPage } from "./archive/pages/SearchPage";
import { SupportPage } from "./archive/pages/SupportPage";
import { PUBLICATIONS, PUBLICATION_NAMES } from "./archive/publications";
import { NotFoundPage } from "./NotFoundPage";
import { PlatformLayout } from "./platform/PlatformLayout";
import { PlatformHomePage } from "./platform/pages/HomePage";
import { LibraryPage } from "./platform/pages/LibraryPage";
import { rollout } from "./rollout";
import { ARCHIVE_ROOT, defaultArchiveIssuePath } from "./routes";
import { refreshFeatureFlags, useFeatureFlag, useFeatureFlagStore, type FeatureFlagKey } from "./featureFlags";
import { startPlatformAccountSync, usePlatformAccountStore } from "./platform/accountSession";

const AccountLogin = lazy(() => import("./account/AccountLogin"));
const AccountConfirmation = lazy(() => import("./account/AccountConfirmation"));
const ReaderPage = lazy(() =>
  import("./archive/pages/ReaderPage").then(({ ReaderPage }) => ({ default: ReaderPage })),
);
const BookReaderPage = lazy(() =>
  import("./rag/pages/ReaderPage").then(({ ReaderPage }) => ({ default: ReaderPage })),
);
const RagRoutes = lazy(() => import("./rag/RagRoutes"));
const OldsRoutes = lazy(() => import("./olds/OldsRoutes"));

const legacyArchivePaths = [...PUBLICATION_NAMES, "search", "support"] as const;
const platformArchivePaths = [...PUBLICATION_NAMES] as const;
const archivePublications = Object.values(PUBLICATIONS);
const accountConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

function ModuleFallback() {
  return <div className="flex min-h-screen items-center justify-center bg-paper font-bold text-red">正在打开 JOJO…</div>;
}

function ArchiveRedirect({ stripPrefix = "" }: { stripPrefix?: string }) {
  const location = useLocation();
  const pathname = `${ARCHIVE_ROOT}${location.pathname.slice(stripPrefix.length)}`;
  return <Navigate to={{ pathname, search: location.search, hash: location.hash }} replace />;
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ModuleFallback />}>{children}</Suspense>;
}

function RuntimeBootstrap() {
  const accountInitialized = usePlatformAccountStore((state) => state.initialized);
  const userId = usePlatformAccountStore((state) => state.userId);
  useEffect(() => startPlatformAccountSync(), []);
  useEffect(() => {
    if (accountInitialized) void refreshFeatureFlags();
  }, [accountInitialized, userId]);
  return null;
}

function FeatureRoute({ flag, children }: { flag: FeatureFlagKey; children: ReactNode }) {
  const initialized = useFeatureFlagStore((state) => state.initialized);
  const enabled = useFeatureFlag(flag);
  if (!initialized) return <ModuleFallback />;
  return enabled ? children : <NotFoundPage />;
}

function AccountEntry() {
  if (accountConfigured) {
    return (
      <Suspense fallback={<main className="min-h-screen bg-paper" aria-label="正在载入登录页面" />}>
        <AccountLogin />
      </Suspense>
    );
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-6 text-ink">
      <div className="max-w-md border-l-2 border-red pl-6">
        <p className="m-0 text-xs font-bold tracking-[.18em] text-red">JOJO ACCOUNT</p>
        <h1 className="my-4 text-3xl font-medium">登录服务未配置</h1>
        <p className="mb-5 text-sm leading-7 text-muted">当前本地环境缺少 Supabase 公开配置；部署环境配置完成后，这里会显示现有登录与邀请注册页面。</p>
        <a className="text-sm font-bold text-red" href="/">返回首页 →</a>
      </div>
    </main>
  );
}

function archiveRoute(platformRedesign: boolean) {
  return (
    <Route path={ARCHIVE_ROOT} element={<Layout platformRedesign={platformRedesign} />}>
      <Route index element={<ArchiveHomePage />} />
      {archivePublications.map((publication) => (
        <Fragment key={publication.name}>
          <Route
            path={`${publication.name}/:id`}
            element={<LazyRoute><ReaderPage type={publication.type} name={publication.name} /></LazyRoute>}
          />
          <Route
            path={publication.name}
            element={<Navigate to={defaultArchiveIssuePath(publication.name)} replace />}
          />
        </Fragment>
      ))}
      <Route path="search" element={<SearchPage platformRedesign={platformRedesign} />} />
      <Route path="support" element={<SupportPage platformRedesign={platformRedesign} />} />
    </Route>
  );
}

function LegacyRoutes() {
  return (
    <Routes>
      {rollout.account && (
        <>
          <Route path="/account" element={<LazyRoute><AccountLogin /></LazyRoute>} />
          <Route path="/account/confirm" element={<LazyRoute><AccountConfirmation /></LazyRoute>} />
          <Route path="/login" element={<Navigate to="/account" replace />} />
        </>
      )}

      <Route path="/" element={<Navigate to={ARCHIVE_ROOT} replace />} />
      {archiveRoute(false)}
      <Route path="/reader/*" element={<ArchiveRedirect stripPrefix="/reader" />} />

      {legacyArchivePaths.map((path) => (
        <Route key={path} path={`/${path}/*`} element={<ArchiveRedirect />} />
      ))}

      {rollout.rag && <Route path="/rag/*" element={<LazyRoute><RagRoutes /></LazyRoute>} />}
      {rollout.olds && <Route path="/olds/*" element={<LazyRoute><OldsRoutes /></LazyRoute>} />}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function PlatformRoutes() {
  return (
    <>
      <RuntimeBootstrap />
      <Routes>
        <Route path="/account" element={<AccountEntry />} />
        <Route path="/account/confirm" element={<LazyRoute><AccountConfirmation /></LazyRoute>} />
        <Route path="/login" element={<Navigate to="/account" replace />} />

        <Route element={<PlatformLayout />}>
          <Route index element={<PlatformHomePage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="library/:datasetId" element={<LibraryPage />} />
          <Route path="search" element={<div className="h-[calc(100vh-64px)] overflow-hidden"><SearchPage platformRedesign /></div>} />
          <Route path="support" element={<SupportPage platformRedesign />} />
        </Route>

        <Route path="/book/:notebookId/:sourceId" element={<LazyRoute><BookReaderPage publicReader /></LazyRoute>} />
        {archiveRoute(true)}
        <Route path="/reader/*" element={<ArchiveRedirect stripPrefix="/reader" />} />
        <Route path="/legacy/*" element={<ArchiveRedirect stripPrefix="/legacy" />} />

        {platformArchivePaths.map((path) => (
          <Route key={path} path={`/${path}/*`} element={<ArchiveRedirect />} />
        ))}

        {rollout.rag && (
          <Route path="/rag/*" element={<FeatureRoute flag="rag.workspace"><LazyRoute><RagRoutes /></LazyRoute></FeatureRoute>} />
        )}
        {rollout.olds && (
          <Route path="/olds/*" element={<FeatureRoute flag="olds.workspace"><LazyRoute><OldsRoutes /></LazyRoute></FeatureRoute>} />
        )}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}

export function AppRoutes({ platformRedesign = rollout.platformRedesign }: { platformRedesign?: boolean }) {
  return platformRedesign ? <PlatformRoutes /> : <LegacyRoutes />;
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
