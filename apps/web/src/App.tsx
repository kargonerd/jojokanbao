import { Fragment, lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./archive/components/Layout";
import { HomePage } from "./archive/pages/HomePage";
import { SearchPage } from "./archive/pages/SearchPage";
import { SupportPage } from "./archive/pages/SupportPage";
import { PUBLICATIONS, PUBLICATION_NAMES } from "./archive/publications";
import { NotFoundPage } from "./NotFoundPage";
import { rollout } from "./rollout";
import { ARCHIVE_ROOT, defaultArchiveIssuePath } from "./routes";

const AccountLogin = lazy(() => import("./account/AccountLogin"));
const ReaderPage = lazy(() =>
  import("./archive/pages/ReaderPage").then(({ ReaderPage }) => ({ default: ReaderPage })),
);
const RagRoutes = lazy(() => import("./rag/RagRoutes"));
const OldsRoutes = lazy(() => import("./olds/OldsRoutes"));

const legacyArchivePaths = [...PUBLICATION_NAMES, "search", "support"] as const;
const archivePublications = Object.values(PUBLICATIONS);

function ModuleFallback() {
  return <div className="flex min-h-screen items-center justify-center bg-paper font-bold text-red">正在打开 JOJO…</div>;
}

function ArchiveRedirect({ stripPrefix = "" }: { stripPrefix?: string }) {
  const location = useLocation();
  const pathname = `${ARCHIVE_ROOT}${location.pathname.slice(stripPrefix.length)}`;
  return (
    <Navigate
      to={{ pathname, search: location.search, hash: location.hash }}
      replace
    />
  );
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ModuleFallback />}>{children}</Suspense>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {rollout.account && (
          <>
            <Route
              path="/account"
              element={
                <LazyRoute>
                  <AccountLogin />
                </LazyRoute>
              }
            />
            <Route path="/login" element={<Navigate to="/account" replace />} />
          </>
        )}

        <Route path="/" element={<Navigate to={ARCHIVE_ROOT} replace />} />

        <Route path={ARCHIVE_ROOT} element={<Layout />}>
          <Route index element={<HomePage />} />

          {archivePublications.map((publication) => (
            <Fragment key={publication.name}>
              <Route
                path={`${publication.name}/:id`}
                element={
                  <LazyRoute>
                    <ReaderPage type={publication.type} name={publication.name} />
                  </LazyRoute>
                }
              />
              <Route
                path={publication.name}
                element={<Navigate to={defaultArchiveIssuePath(publication.name)} replace />}
              />
            </Fragment>
          ))}

          <Route path="search" element={<SearchPage />} />
          <Route path="support" element={<SupportPage />} />
        </Route>

        <Route path="/reader/*" element={<ArchiveRedirect stripPrefix="/reader" />} />

        {legacyArchivePaths.map((path) => (
          <Route key={path} path={`/${path}/*`} element={<ArchiveRedirect />} />
        ))}

        {rollout.rag && (
          <Route
            path="/rag/*"
            element={
              <LazyRoute>
                <RagRoutes />
              </LazyRoute>
            }
          />
        )}
        {rollout.olds && (
          <Route
            path="/olds/*"
            element={
              <LazyRoute>
                <OldsRoutes />
              </LazyRoute>
            }
          />
        )}

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
