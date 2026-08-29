import { Route, Routes } from "react-router-dom";
import { NotFoundPage } from "../NotFoundPage";
import { TimesHomePage } from "./pages/TimesHomePage";

export default function TimesRoutes() {
  return (
    <Routes>
      <Route index element={<TimesHomePage />} />
      <Route path=":issueDate/:newsId" element={<TimesHomePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
