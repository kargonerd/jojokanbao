import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/auth";
import { AccountShell } from "@/components/AccountShell";
import { LoadingPage } from "@/components/LoadingPage";

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const { initialized, user, error } = useAuthStore();
  const callbackError = new URLSearchParams(window.location.search).get("error_description");

  useEffect(() => {
    if (initialized && user) navigate("/account", { replace: true });
  }, [initialized, navigate, user]);

  if (!initialized || user) {
    return (
      <AccountShell compact>
        <LoadingPage label="正在确认邮箱…" />
      </AccountShell>
    );
  }

  return (
    <AccountShell compact>
      <div className="mx-auto max-w-xl border border-rule bg-paper p-8 md:p-12">
        <p className="font-sans text-[10px] font-bold tracking-[0.24em] text-red uppercase">Verification failed</p>
        <h1 className="mt-4 text-2xl font-black">确认链接没有完成</h1>
        <p role="alert" className="mt-4 text-sm leading-7 text-muted">{callbackError ?? error ?? "链接可能已经使用或过期，请重新登录。"}</p>
        <Link to="/login" className="mt-7 inline-block text-sm font-bold">返回登录 →</Link>
      </div>
    </AccountShell>
  );
}
