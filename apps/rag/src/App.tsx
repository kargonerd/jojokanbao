import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ChatPage } from "./pages/ChatPage";
import { ReaderPage } from "./pages/ReaderPage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminAccounts } from "./pages/admin/AdminAccounts";
import { AdminLibraries } from "./pages/admin/AdminLibraries";
import { AdminLibraryEditor } from "./pages/admin/AdminLibraryEditor";
import { AdminSourceEditor } from "./pages/admin/AdminSourceEditor";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/source/:notebookId/:sourceId" element={<ReaderPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="accounts" replace />} />
          <Route path="accounts" element={<AdminAccounts />} />
          <Route path="libraries" element={<AdminLibraries />} />
          <Route path="libraries/:notebookId" element={<AdminLibraryEditor />} />
          <Route path="libraries/:notebookId/sources/:sourceId" element={<AdminSourceEditor />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
