import { useEffect } from "react";
import { startAuthSync, useAuthStore } from "./auth";
import { AccountShell } from "./components/AccountShell";
import { LoadingPage } from "./components/LoadingPage";
import { LoginPage } from "./pages/LoginPage";

export default function AccountLogin() {
  const initialized = useAuthStore((state) => state.initialized);

  useEffect(() => startAuthSync(), []);

  if (!initialized) {
    return (
      <AccountShell compact>
        <LoadingPage />
      </AccountShell>
    );
  }

  return <LoginPage />;
}
