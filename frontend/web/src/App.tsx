import { Fragment, lazy, Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./archive/components/Layout";
import { HomePage as ArchiveHomePage } from "./archive/pages/HomePage";
import { SearchPage } from "./archive/pages/SearchPage";
import { SupportPage } from "./archive/pages/SupportPage";
import { PUBLICATIONS, PUBLICATION_NAMES } from "./archive/publications";
import { NotFoundPage } from "./NotFoundPage";
import { AppLayout } from "./shell/AppLayout";
import { HomePage } from "./home/HomePage";
import { LibraryPage } from "./library/LibraryPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { PERIODICALS } from "./library/catalog";
import { rollout } from "./rollout";
import { ARCHIVE_ROOT, defaultArchiveIssuePath } from "./routes";
import { refreshFeatureFlags } from "./featureFlags";
import { AccountEntry } from "./account/AccountEntry";
import { startAccountSessionSync, useAccountSessionStore } from "./account/session";

const AccountLogin = lazy(() => import("./account/AccountLogin"));
const AccountConfirmation = lazy(() => import("./account/AccountConfirmation"));
const ReaderPage = lazy(() =>
  import("./archive/pages/ReaderPage").then(({ ReaderPage }) => ({ default: ReaderPage })),
);
const BookReaderPage = lazy(() =>
  import("./rag/pages/ReaderPage").then(({ ReaderPage }) => ({ default: ReaderPage })),
);
const RagRoutes = lazy(() => import("./rag/RagRoutes"));
const TimesRoutes = lazy(() => import("./times/TimesRoutes"));

const legacyArchivePaths = [...PUBLICATION_NAMES, "search", "support"] as const;
const redesignedArchivePaths = [...PUBLICATION_NAMES] as const;
const archivePublications = Object.values(PUBLICATIONS);

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
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  useEffect(() => startAccountSessionSync(), []);
  useEffect(() => {
    if (accountInitialized) void refreshFeatureFlags();
  }, [accountInitialized, userId]);
  return null;
}

function AuthenticatedRoute({ children }: { children: ReactNode }) {
  const initialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const location = useLocation();
  if (!initialized) return <ModuleFallback />;
  if (!userId) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/account?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return children;
}

function TimesAccessRoute({ children }: { children: ReactNode }) {
  const publicTimeline = import.meta.env.VITE_TIMES_PUBLIC === "true";
  return publicTimeline ? children : <AuthenticatedRoute>{children}</AuthenticatedRoute>;
}

function archiveRoute(platformRedesign: boolean) {
  return (
    <Route path={ARCHIVE_ROOT} element={<Layout platformRedesign={platformRedesign} />}>
      <Route index element={platformRedesign ? <Navigate to="/library" replace /> : <ArchiveHomePage />} />
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

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function RedesignedRoutes() {
  return (
    <>
      <RuntimeBootstrap />
      <Routes>
        <Route path="/account" element={<AccountEntry />} />
        <Route path="/account/confirm" element={<LazyRoute><AccountConfirmation /></LazyRoute>} />
        <Route path="/login" element={<Navigate to="/account" replace />} />

        <Route element={<AppLayout />}>
          <Route index element={<HomePage periodicals={PERIODICALS} />} />
          <Route path="library" element={<LibraryPage periodicals={PERIODICALS} />} />
          <Route path="library/:datasetId" element={<LibraryPage periodicals={PERIODICALS} />} />
          <Route path="search" element={<div className="h-[calc(100vh-64px)] overflow-hidden"><SearchPage platformRedesign /></div>} />
          <Route path="support" element={<SupportPage platformRedesign />} />
          <Route path="notifications" element={<NotificationsPage />} />
          {rollout.rag && (
            <Route path="rag/*" element={<AuthenticatedRoute><LazyRoute><RagRoutes /></LazyRoute></AuthenticatedRoute>} />
          )}
          {rollout.times && (
            <Route path="times/*" element={<TimesAccessRoute><LazyRoute><TimesRoutes /></LazyRoute></TimesAccessRoute>} />
          )}
        </Route>

        {rollout.rag && (
          <Route path="/book/:notebookId/:sourceId" element={<AuthenticatedRoute><LazyRoute><BookReaderPage /></LazyRoute></AuthenticatedRoute>} />
        )}
        {archiveRoute(true)}
        <Route path="/reader/*" element={<ArchiveRedirect stripPrefix="/reader" />} />
        <Route path="/legacy/*" element={<Navigate to="/" replace />} />

        {redesignedArchivePaths.map((path) => (
          <Route key={path} path={`/${path}/*`} element={<ArchiveRedirect />} />
        ))}

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}

export function AppRoutes({ platformRedesign = rollout.platformRedesign }: { platformRedesign?: boolean }) {
  return platformRedesign ? <RedesignedRoutes /> : <LegacyRoutes />;
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
