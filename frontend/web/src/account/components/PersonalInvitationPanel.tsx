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

const quietButton =
  "border border-red bg-red px-5 py-3 font-serif text-sm font-black tracking-[0.12em] text-white transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none";

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
  const canGenerate = !status?.allocated || (
    !status.redeemed && !status.disabled
  );

  const copyCode = async () => {
    if (!status?.allocated) return;
    try {
      await navigator.clipboard.writeText(status.code);
      setCopyNotice("已复制");
    } catch {
      setCopyNotice("复制失败，请长按邀请码复制");
    }
  };

  const rotateCode = () => {
    if (
      status?.allocated
      && !expired
      && !window.confirm("换码后，旧邀请码会立即失效。确定继续吗？")
    ) {
      return;
    }
    setCopyNotice("");
    void generate();
  };

  let statusLabel = "尚未生成";
  if (status?.allocated) {
    if (status.disabled) statusLabel = "已停用";
    else if (status.redeemed) statusLabel = "已使用";
    else if (expired) statusLabel = "已过期";
    else statusLabel = "可使用";
  }

  return (
    <section aria-labelledby="invitation-title">
      <header className="flex items-end justify-between border-b-2 border-red pb-4">
        <div>
          <span className="font-sans text-[0.65rem] font-black tracking-[0.18em] text-red">
            个人账号
          </span>
          <h1
            id="invitation-title"
            className="mb-0 mt-2 font-serif text-3xl font-black tracking-[0.1em] sm:text-4xl"
          >
            我的邀请码
          </h1>
        </div>
        <b className={`pb-1 text-xs tracking-[0.08em] ${statusLabel === "可使用" ? "text-red" : "text-muted"}`}>
          {statusLabel}
        </b>
      </header>

      {!ready || loading ? (
        <p className="my-8 text-sm font-bold text-muted" role="status">
          正在查阅邀请码…
        </p>
      ) : status?.allocated ? (
        <div className="my-8 border border-red bg-paper p-5 sm:p-6">
          <span className="font-sans text-[0.6rem] font-black tracking-[0.18em] text-muted">
            JOJO · INVITATION
          </span>
          <strong
            aria-label={`邀请码 ${status.code}`}
            className="my-6 grid grid-cols-6 gap-2"
          >
            {Array.from(status.code).map((character, index) => (
              <span
                key={`${character}-${index}`}
                className="border-b-2 border-red pb-2 text-center font-serif text-2xl text-red sm:text-3xl"
              >
                {character}
              </span>
            ))}
          </strong>
          <div className="flex flex-wrap items-center justify-between gap-3 font-sans text-xs text-muted">
            <span>有效期至 {formatExpiry(status.expires_at)}</span>
            {!status.redeemed && !status.disabled && (
              <button
                type="button"
                onClick={() => void copyCode()}
                className="border-0 border-b border-red bg-transparent px-0 py-1 font-bold text-red hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red"
              >
                复制邀请码
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="my-8 text-sm font-bold leading-8 text-muted">
          每位读者可以生成一枚邀请码，赠予一位新读者。邀请码 30 天内有效，使用后即作废。
        </p>
      )}

      {(error || copyNotice) && (
        <p
          className={`mb-6 border-l-2 border-red pl-4 text-sm font-bold leading-7 ${error ? "text-red" : "text-ink"}`}
          role={error ? "alert" : "status"}
        >
          {error ?? copyNotice}
        </p>
      )}

      {canGenerate && ready && !loading && (
        <button
          type="button"
          disabled={generating}
          onClick={rotateCode}
          className={quietButton}
        >
          {generating
            ? "正在生成…"
            : status?.allocated
              ? expired ? "重新生成" : "换一个邀请码"
              : "生成邀请码"}
        </button>
      )}

      {status?.allocated && (status.redeemed || status.disabled) && (
        <p className="mt-6 border-t border-rule pt-4 text-sm font-bold leading-7 text-muted">
          {status.disabled
            ? "这枚邀请码已由管理员停用。"
            : "这枚邀请码已经完成注册，不能再次生成。"}
        </p>
      )}
    </section>
  );
}
