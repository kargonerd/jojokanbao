import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AdminShell } from "./components/AdminShell";
import { OverviewPage } from "./pages/OverviewPage";
import { PdfDataPage } from "./pages/PdfDataPage";
import { EsDataPage } from "./pages/EsDataPage";
import { ContentDataPage } from "./pages/ContentDataPage";
import { FeatureFlagsPage } from "./features/FeatureFlagsPage";
import { AgentAdminPage } from "./agent/AgentAdminPage";
import { ModerationPage } from "./moderation/ModerationPage";
import { RmrbReviewPage } from "./rmrb/RmrbReviewPage";
import { RmrbReconciliationPage } from "./rmrb/RmrbReconciliationPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AdminShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="pdf" element={<PdfDataPage />} />
          <Route path="es" element={<EsDataPage />} />
          <Route path="content" element={<ContentDataPage />} />
          <Route path="features" element={<FeatureFlagsPage />} />
          <Route path="agent" element={<AgentAdminPage />} />
          <Route path="moderation" element={<ModerationPage />} />
          <Route path="rmrb-review" element={<RmrbReviewPage />} />
          <Route path="rmrb-title-review" element={<RmrbReconciliationPage />} />
          <Route path="es-repair" element={<Navigate replace to="/es" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
