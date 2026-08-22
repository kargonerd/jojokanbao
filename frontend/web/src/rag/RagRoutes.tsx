import { Navigate, Route, Routes } from "react-router-dom";
import { NotFoundPage } from "../NotFoundPage";
import { ChatPage } from "./pages/ChatPage";

export default function RagRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="chat" replace />} />
      <Route path="chat" element={<ChatPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
