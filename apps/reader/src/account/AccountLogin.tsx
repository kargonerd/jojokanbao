import { useEffect } from "react";
import { startAuthSync, useAuthStore } from "./auth";
import { LoadingPage } from "./components/LoadingPage";
import { LoginPage } from "./pages/LoginPage";
import "./styles.css";

export default function AccountLogin() {
  const initialized = useAuthStore((state) => state.initialized);

  useEffect(() => startAuthSync(), []);

  if (!initialized) {
    return <LoadingPage />;
  }

  return <LoginPage />;
}
