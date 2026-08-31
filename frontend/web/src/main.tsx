import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@jojo/ui/styles";
import { App } from "./App";
import { applyBetaMetadata } from "./betaChannel";

applyBetaMetadata();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
