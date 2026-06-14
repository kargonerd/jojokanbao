import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { ReaderPage } from "./pages/ReaderPage";
import { SearchPage } from "./pages/SearchPage";
import { SupportPage } from "./pages/SupportPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
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
