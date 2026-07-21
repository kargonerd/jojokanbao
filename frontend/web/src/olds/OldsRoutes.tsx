import { Route, Routes } from "react-router-dom";
import { NotFoundPage } from "../NotFoundPage";
import { OldsDetailPage } from "./pages/OldsDetailPage";
import { OldsHomePage } from "./pages/OldsHomePage";

export default function OldsRoutes() {
  return (
    <Routes>
      <Route index element={<OldsHomePage />} />
      <Route path=":newsId" element={<OldsDetailPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
