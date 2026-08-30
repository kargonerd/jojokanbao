import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";

const AccountLogin = lazy(() => import("./AccountLogin"));

const accountConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

export function AccountEntry() {
  if (accountConfigured) {
    return (
      <Suspense fallback={<main className="min-h-screen bg-paper" aria-label="正在载入登录页面" />}>
        <AccountLogin />
      </Suspense>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-6 text-ink">
      <div className="max-w-md border-l-2 border-red pl-6">
        <h1 className="my-4 text-3xl font-medium">登录暂不可用</h1>
        <p className="mb-5 text-sm leading-7 text-muted">
          当前无法连接登录服务，请稍后再试。
        </p>
        <div className="flex gap-5 text-sm font-bold text-red">
          <Link to="/">返回首页 →</Link>
          <Link to="/support">关于 JOJO 看报 →</Link>
        </div>
      </div>
    </main>
  );
}
