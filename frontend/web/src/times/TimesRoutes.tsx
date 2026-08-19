import { Route, Routes } from "react-router-dom";
import { NotFoundPage } from "../NotFoundPage";
import { TimesDetailPage } from "./pages/TimesDetailPage";
import { TimesHomePage } from "./pages/TimesHomePage";
import { TimesSourcesPage } from "./pages/TimesSourcesPage";

export default function TimesRoutes() {
  return (
    <Routes>
      <Route index element={<TimesHomePage />} />
      <Route path="sources" element={<TimesSourcesPage />} />
      <Route path=":newsId" element={<TimesDetailPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
