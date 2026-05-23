import { BrowserRouter, Routes, Route } from "react-router-dom";
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
          <Route path="/rmrb/:id" element={<ReaderPage type="newspaper" name="rmrb" />} />
          <Route path="/ckxx/:id" element={<ReaderPage type="newspaper" name="ckxx" />} />
          <Route path="/hq/:id" element={<ReaderPage type="magazine" name="hq" />} />
          <Route path="/rmhb/:id" element={<ReaderPage type="magazine" name="rmhb" />} />
          <Route path="/sjzs/:id" element={<ReaderPage type="magazine" name="sjzs" />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
