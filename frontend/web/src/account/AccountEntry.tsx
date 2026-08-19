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
        <p className="m-0 text-xs font-bold tracking-[.18em] text-red">JOJO ACCOUNT</p>
        <h1 className="my-4 text-3xl font-medium">登录服务未配置</h1>
        <p className="mb-5 text-sm leading-7 text-muted">
          当前本地环境缺少 Supabase 公开配置；部署环境配置完成后，这里会显示现有登录与邀请注册页面。
        </p>
        <Link className="text-sm font-bold text-red" to="/">返回首页 →</Link>
      </div>
    </main>
  );
}
