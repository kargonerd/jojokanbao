import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { WorkbenchShell } from "./components/WorkbenchShell";
import { OverviewPage } from "./pages/OverviewPage";
import { PdfDataPage } from "./pages/PdfDataPage";
import { EsDataPage } from "./pages/EsDataPage";
import { ContentDataPage } from "./pages/ContentDataPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<WorkbenchShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="pdf" element={<PdfDataPage />} />
          <Route path="es" element={<EsDataPage />} />
          <Route path="content" element={<ContentDataPage />} />
          <Route path="es-repair" element={<Navigate replace to="/es" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
