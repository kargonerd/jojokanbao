import { useEffect, useState } from "react";
import { usePersonalInvitationStore } from "../invitationStore";

interface PersonalInvitationPanelProps {
  userId: string;
}

function formatExpiry(value: string | null): string {
  if (!value) return "长期有效";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

const actionButton =
  "border border-red bg-red px-4 py-2 font-serif text-sm font-black tracking-[0.08em] text-white transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none";

export function PersonalInvitationPanel({ userId }: PersonalInvitationPanelProps) {
  const {
    ownerUserId,
    status: storedStatus,
    loading,
    generating,
    error,
    load,
    generate,
  } = usePersonalInvitationStore();
  const [copyNotice, setCopyNotice] = useState("");
  const ready = ownerUserId === userId;
  const status = ready ? storedStatus : null;

  useEffect(() => {
    void load(userId);
  }, [load, userId]);

  const expired = status?.allocated && status.expires_at
    ? new Date(status.expires_at).getTime() <= Date.now()
    : false;
  const invitationUnavailable = status?.allocated && (
    status.redeemed || status.disabled || expired
  );

  let lifecycleText = "";
  if (status?.allocated) {
    if (status.disabled) lifecycleText = "已停用";
    else if (status.redeemed) lifecycleText = "已使用";
    else if (expired) lifecycleText = "已过期";
    else lifecycleText = status.expires_at
      ? `有效至 ${formatExpiry(status.expires_at)}`
      : "长期有效";
  }

  const copyCode = async () => {
    if (!status?.allocated) return;
    try {
      await navigator.clipboard.writeText(status.code);
      setCopyNotice("已复制");
    } catch {
      setCopyNotice("复制失败，请长按邀请码复制");
    }
  };

  const generateCode = () => {
    setCopyNotice("");
    void generate();
  };

  return (
    <section aria-labelledby="invitation-title" className="grid gap-3 border-t border-rule py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
      <h2 id="invitation-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">
        邀请码
      </h2>

      <div>
        {!ready || loading ? (
          <p className="m-0 text-sm font-bold text-muted" role="status">
            正在读取…
          </p>
        ) : status?.allocated ? (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <strong
                aria-label={`邀请码 ${status.code}`}
                className={`font-serif text-3xl font-black tracking-[0.22em] ${invitationUnavailable ? "text-muted" : "text-red"}`}
              >
                {status.code}
              </strong>
              {!status.redeemed && !status.disabled && !expired && (
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  className="border-0 border-b border-red bg-transparent px-0 py-1 text-xs font-bold text-red hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red"
                >
                  复制
                </button>
              )}
            </div>
            <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">
              {lifecycleText}
            </p>
            {expired && !status.disabled && !status.redeemed && (
              <button
                type="button"
                disabled={generating}
                onClick={generateCode}
                className={`${actionButton} mt-4`}
              >
                {generating ? "正在生成…" : "重新生成邀请码"}
              </button>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <p className="m-0 text-sm font-bold leading-7 text-muted">
              可邀请一位新读者，30 天内有效。
            </p>
            <button
              type="button"
              disabled={generating}
              onClick={generateCode}
              className={actionButton}
            >
              {generating ? "正在生成…" : "生成邀请码"}
            </button>
          </div>
        )}

        {(error || copyNotice) && (
          <p
            className={`mb-0 mt-3 border-l-2 border-red pl-3 text-sm font-bold leading-7 ${error ? "text-red" : "text-ink"}`}
            role={error ? "alert" : "status"}
          >
            {error ?? copyNotice}
          </p>
        )}
      </div>
    </section>
  );
}
