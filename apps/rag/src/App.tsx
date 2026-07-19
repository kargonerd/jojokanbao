import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ChatPage } from "./pages/ChatPage";
import { ReaderPage } from "./pages/ReaderPage";
import { DocumentsPage } from "./pages/DocumentsPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/admin" element={<Navigate to="/documents" replace />} />
        <Route path="/source/:notebookId/:sourceId" element={<ReaderPage />} />
      </Routes>
    </BrowserRouter>
  );
}
