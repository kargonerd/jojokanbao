import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { ReaderPage } from "./pages/ReaderPage";
import { SearchPage } from "./pages/SearchPage";
import { SupportPage } from "./pages/SupportPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { rollout } from "./rollout";

const AccountLogin = lazy(() => import("./account/AccountLogin"));

function AccountFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper font-bold text-red">
      正在打开账号登录…
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {rollout.account && (
          <Route
            path="/login"
            element={
              <Suspense fallback={<AccountFallback />}>
                <AccountLogin />
              </Suspense>
            }
          />
        )}

        <Route element={<Layout />}>
          <Route index element={<HomePage />} />

          {/* Newspaper routes */}
          <Route path="/rmrb/:id" element={<ReaderPage type="newspaper" name="rmrb" />} />
          <Route path="/rmrb" element={<Navigate to="/rmrb/19701009" replace />} />
          <Route path="/ckxx/:id" element={<ReaderPage type="newspaper" name="ckxx" />} />
          <Route path="/ckxx" element={<Navigate to="/ckxx/19760910" replace />} />

          {/* Magazine routes */}
          <Route path="/hq/:id" element={<ReaderPage type="magazine" name="hq" />} />
          <Route path="/hq" element={<Navigate to="/hq/196419" replace />} />
          <Route path="/rmhb/:id" element={<ReaderPage type="magazine" name="rmhb" />} />
          <Route path="/rmhb" element={<Navigate to="/rmhb/197292" replace />} />
          <Route path="/sjzs/:id" element={<ReaderPage type="magazine" name="sjzs" />} />
          <Route path="/sjzs" element={<Navigate to="/sjzs/196513" replace />} />

          <Route path="/search" element={<SearchPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
