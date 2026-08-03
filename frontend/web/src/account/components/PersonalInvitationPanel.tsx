import { useEffect, useState } from "react";
import { usePersonalInvitationStore } from "../invitationStore";

function formatExpiry(value: string | null): string {
  if (!value) return "长期有效";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

interface PersonalInvitationPanelProps {
  userId: string;
}

export function PersonalInvitationPanel({ userId }: PersonalInvitationPanelProps) {
  const {
    ownerUserId,
    status: storedStatus,
    loading,
    generating,
    error,
    load,
    generate,
  } =
    usePersonalInvitationStore();
  const ready = ownerUserId === userId;
  const status = ready ? storedStatus : null;
  const [copyNotice, setCopyNotice] = useState("");

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
    <section className="account-invitation" aria-labelledby="invitation-title">
      <header className="account-section-heading">
        <div>
          <span>赠阅凭证</span>
          <h2 id="invitation-title">我的邀请码</h2>
        </div>
        <b data-status={statusLabel}>{statusLabel}</b>
      </header>

      {!ready || loading ? (
        <p className="account-invitation__loading" role="status">正在查阅邀请码…</p>
      ) : status?.allocated ? (
        <div className="account-invitation__ticket">
          <span className="account-invitation__serial">JOJO · INVITATION</span>
          <strong aria-label={`邀请码 ${status.code}`}>
            {Array.from(status.code).map((character, index) => (
              <span key={`${character}-${index}`}>{character}</span>
            ))}
          </strong>
          <div className="account-invitation__meta">
            <span>有效期至 {formatExpiry(status.expires_at)}</span>
            {!status.redeemed && !status.disabled && (
              <button type="button" onClick={() => void copyCode()}>
                复制邀请码
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="account-invitation__empty">
          每位读者可以生成一枚邀请码，赠予一位新读者。邀请码 30 天内有效，使用后即作废。
        </p>
      )}

      {(error || copyNotice) && (
        <p
          className={`account-invitation__notice${error ? " account-invitation__notice--error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ?? copyNotice}
        </p>
      )}

      {canGenerate && ready && !loading && (
        <button
          className="account-invitation__generate"
          type="button"
          disabled={generating}
          onClick={rotateCode}
        >
          {generating
            ? "正在生成…"
            : status?.allocated
              ? expired ? "重新生成" : "换一个邀请码"
              : "生成邀请码"}
        </button>
      )}

      {status?.allocated && (status.redeemed || status.disabled) && (
        <p className="account-invitation__final">
          {status.disabled
            ? "这枚邀请码已由管理员停用。"
            : "这枚邀请码已经完成注册，不能再次生成。"}
        </p>
      )}
    </section>
  );
}
