import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { startAuthSync, useAuthStore } from "@/auth";
import { AccountShell } from "@/components/AccountShell";
import { LoadingPage } from "@/components/LoadingPage";
import { AccountPage } from "@/pages/AccountPage";
import { AuthCallbackPage } from "@/pages/AuthCallbackPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { LoginPage } from "@/pages/LoginPage";
import { RegisterPage } from "@/pages/RegisterPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";

function AuthBootstrap({ children }: { children: ReactNode }) {
  useEffect(() => startAuthSync(), []);
  return children;
}

function EntryRoute() {
  const { initialized, user } = useAuthStore();
  if (!initialized) return <LoadingPage />;
  return <Navigate to={user ? "/account" : "/login"} replace />;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { initialized, user } = useAuthStore();
  if (!initialized) return <LoadingPage />;
  return user ? children : <Navigate to="/login" replace />;
}

function NotFoundPage() {
  return (
    <AccountShell compact>
      <div className="mx-auto max-w-xl border border-rule bg-paper p-10 text-center">
        <p className="font-sans text-xs font-bold tracking-[0.24em] text-red">404 / ARCHIVE NOT FOUND</p>
        <h1 className="mt-5 text-3xl font-black">这一页不存在</h1>
        <a href="/" className="mt-7 inline-block text-sm font-bold">返回账号中心 →</a>
      </div>
    </AccountShell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthBootstrap>
        <Routes>
          <Route path="/" element={<EntryRoute />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/account" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthBootstrap>
    </BrowserRouter>
  );
}
