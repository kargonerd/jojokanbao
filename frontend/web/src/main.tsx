import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@jojo/ui/styles";
import { App } from "./App";
import { applyBetaMetadata } from "./betaChannel";
import { analytics } from "@jojo/analytics";

applyBetaMetadata();
void import("@jojo/analytics/browser").then(({ initializeBrowserAnalytics }) => initializeBrowserAnalytics({
  token: import.meta.env.VITE_POSTHOG_TOKEN,
  host: import.meta.env.VITE_POSTHOG_HOST,
  production: import.meta.env.PROD && import.meta.env.VITE_RELEASE_CHANNEL !== "preview",
  context: { client: "web", platform: "web", app_variant: "standard",
    app_version: import.meta.env.VITE_APP_VERSION || "web",
    release_channel: import.meta.env.VITE_RELEASE_CHANNEL || "stable" },
})).catch(() => undefined);

createRoot(document.getElementById("root")!, {
  onCaughtError: (error) => { console.error(error); analytics.exception(error, "react"); },
  onUncaughtError: (error) => { console.error(error); analytics.exception(error, "react"); },
}).render(
  <StrictMode>
    <App />
  </StrictMode>
);
