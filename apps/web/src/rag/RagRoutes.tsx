import { Navigate, Route, Routes } from "react-router-dom";
import { NotFoundPage } from "../NotFoundPage";
import { ChatPage } from "./pages/ChatPage";
import { ReaderPage } from "./pages/ReaderPage";

export default function RagRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="chat" replace />} />
      <Route path="chat" element={<ChatPage />} />
      <Route path="source/:notebookId/:sourceId" element={<ReaderPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
