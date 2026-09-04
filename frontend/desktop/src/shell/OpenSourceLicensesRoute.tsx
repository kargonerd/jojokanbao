import {
  OpenSourceLicensesPage,
  type OpenSourceLicenseData,
} from "@jojo/web/desktop";
import generatedNotices from "../legal/open-source-notices.generated.json";

export default function OpenSourceLicensesRoute() {
  return (
    <OpenSourceLicensesPage
      data={generatedNotices as OpenSourceLicenseData}
      editionLabel="桌面版"
    />
  );
}
