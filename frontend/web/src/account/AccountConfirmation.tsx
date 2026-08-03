import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { confirmSignupEmail } from "./auth";
import { ConfirmationShell } from "./components/ConfirmationShell";
import { ResendConfirmationForm } from "./components/ResendConfirmationForm";

type ConfirmationStatus = "verifying" | "confirmed" | "invalid";

export default function AccountConfirmation() {
  const [searchParams] = useSearchParams();
  const started = useRef(false);
  const [status, setStatus] = useState<ConfirmationStatus>("verifying");

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const tokenHash = searchParams.get("token_hash");
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("token_hash");
    window.history.replaceState(
      window.history.state,
      "",
      `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
    );

    if (!tokenHash) {
      setStatus("invalid");
      return;
    }

    void confirmSignupEmail(tokenHash)
      .then(() => setStatus("confirmed"))
      .catch(() => setStatus("invalid"));
  }, [searchParams]);

  if (status === "verifying") {
    return (
      <ConfirmationShell>
        <h1 className="m-0 font-serif text-3xl font-bold tracking-[0.08em]">
          正在确认邮箱
        </h1>
        <div className="mt-8 flex items-center gap-4 border-t border-rule pt-6 text-sm text-muted">
          <span className="block h-6 w-6 animate-spin border-2 border-rule border-t-red" />
          正在核验这封邮件中的一次性链接…
        </div>
      </ConfirmationShell>
    );
  }

  if (status === "confirmed") {
    return (
      <ConfirmationShell>
        <h1 className="m-0 font-serif text-3xl font-bold tracking-[0.08em]">
          邮箱已经确认
        </h1>
        <p className="mt-5 text-base leading-8 text-muted">
          账号登记完成，现在可以进入 JOJO 看报。
        </p>
        <Link
          to="/archive"
          className="mt-8 inline-block border border-red bg-red px-7 py-3 font-serif text-sm font-bold tracking-[0.12em] text-white no-underline transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:text-white hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red"
        >
          进入首页
        </Link>
      </ConfirmationShell>
    );
  }

  return (
    <ConfirmationShell>
      <h1 className="m-0 font-serif text-3xl font-bold tracking-[0.08em]">
        确认链接已失效
      </h1>
      <p className="mt-5 text-base leading-8 text-muted">
        链接可能已经使用或超过有效期。填写注册邮箱，我们会重新发送一封确认邮件。
      </p>

      <ResendConfirmationForm />

      <Link
        to="/account"
        className="mt-7 inline-block text-sm font-bold text-red underline decoration-red/40 underline-offset-4 hover:text-red"
      >
        返回登录
      </Link>
    </ConfirmationShell>
  );
}
