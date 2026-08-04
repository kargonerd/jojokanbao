import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  confirmSignupEmail,
  getCurrentReaderDisplayName,
} from "./auth";
import { ConfirmationShell } from "./components/ConfirmationShell";
import { ResendConfirmationForm } from "./components/ResendConfirmationForm";

type ConfirmationState =
  | { status: "verifying" }
  | { status: "confirmed"; displayName: string | null }
  | { status: "invalid" };

export default function AccountConfirmation() {
  const [searchParams] = useSearchParams();
  const started = useRef(false);
  const [state, setState] = useState<ConfirmationState>({
    status: "verifying",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [readerCodeError, setReaderCodeError] = useState(false);

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
      setState({ status: "invalid" });
      return;
    }

    void confirmSignupEmail(tokenHash)
      .then(({ displayName }) =>
        setState({ status: "confirmed", displayName }),
      )
      .catch(() => setState({ status: "invalid" }));
  }, [searchParams]);

  const refreshDisplayName = async () => {
    setRefreshing(true);
    setReaderCodeError(false);
    try {
      const displayName = await getCurrentReaderDisplayName();
      setState({ status: "confirmed", displayName });
    } catch {
      setReaderCodeError(true);
    } finally {
      setRefreshing(false);
    }
  };

  if (state.status === "verifying") {
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

  if (state.status === "confirmed") {
    const hasDisplayName = Boolean(state.displayName);
    return (
      <ConfirmationShell>
        <h1 className="m-0 font-serif text-3xl font-bold tracking-[0.08em]">
          邮箱验证成功
        </h1>
        <p className="mb-0 mt-4 text-sm font-bold leading-7 text-muted">
          账号登记完成。请记住系统为你分配的读者代号。
        </p>

        <section
          aria-labelledby="confirmed-reader-code"
          className="mt-7 border-y-2 border-red py-5"
        >
          <p
            id="confirmed-reader-code"
            className="m-0 font-sans text-[0.65rem] font-black tracking-[0.18em] text-red"
          >
            你的读者代号
          </p>
          <strong
            className={`mt-2 block font-serif text-4xl font-black tracking-[0.1em] ${
              hasDisplayName ? "text-ink" : "text-muted"
            }`}
          >
            {state.displayName || "正在分配"}
          </strong>
          <p className="mb-0 mt-3 text-xs font-bold leading-6 text-muted">
            {hasDisplayName
              ? "代号取自全球动植物名称，登录后可在个人账号中再次查看。"
              : readerCodeError
                ? "暂时无法读取代号，请检查网络后重试。"
                : "邮箱已经验证，但代号尚未完成分配，请稍后重新读取。"}
          </p>
        </section>

        {hasDisplayName ? (
          <Link
            to="/archive"
            className="mt-7 inline-block border border-red bg-red px-7 py-3 font-serif text-sm font-bold tracking-[0.12em] text-white no-underline transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:text-white hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red"
          >
            记住了，进入首页
          </Link>
        ) : (
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void refreshDisplayName()}
            className="mt-7 border border-red bg-red px-7 py-3 font-serif text-sm font-bold tracking-[0.12em] text-white transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? "正在读取…" : "重新读取代号"}
          </button>
        )}
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
