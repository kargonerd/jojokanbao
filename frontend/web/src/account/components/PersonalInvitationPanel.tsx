import { useCallback, useEffect, useState } from "react";
import {
  getAuthErrorMessage,
  type PersonalInvitation,
  type PersonalInvitationStatus,
} from "@jojo/auth";
import { personalInvitations } from "@/account/auth";

function formatExpiry(value: string | null | undefined) {
  if (!value) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

export function PersonalInvitationPanel() {
  const [status, setStatus] = useState<PersonalInvitationStatus | null>(null);
  const [invitation, setInvitation] = useState<PersonalInvitation | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await personalInvitations.getStatus());
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const generated = await personalInvitations.generate();
      setInvitation(generated);
      setStatus({
        allocated: true,
        redeemed: false,
        expires_at: generated.expires_at,
        disabled: false,
      });
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      setCopied(true);
    } catch {
      setError("无法自动复制，请手动选择邀请码。");
    }
  };

  const expiry = formatExpiry(invitation?.expires_at ?? status?.expires_at);
  const canGenerate = status !== null && !status.redeemed;

  return (
    <section
      className="personal-invitation"
      aria-labelledby="personal-invitation-title"
    >
      <div>
        <p className="account-center__eyebrow">邀请读者</p>
        <h2 id="personal-invitation-title">我的邀请码</h2>
      </div>

      {busy && !status ? (
        <p className="account-center__muted">正在读取邀请码状态…</p>
      ) : status?.redeemed ? (
        <p>你的邀请码已经被使用。每个账号只有一个邀请名额。</p>
      ) : (
        <p>
          每个账号可以邀请一位新读者。邀请码生成后 30 天内有效；
          未使用时可以重新生成，旧码会立即失效。
        </p>
      )}

      {invitation && (
        <div className="personal-invitation__code">
          <code>{invitation.code}</code>
          <button type="button" onClick={() => void copy()}>
            {copied ? "已复制" : "复制"}
          </button>
          <small>请现在保存；刷新页面后不会再次显示明文。</small>
        </div>
      )}

      {expiry && !status?.redeemed && (
        <p className="account-center__muted">有效期至 {expiry}</p>
      )}
      {error && (
        <p className="account-center__error" role="alert">
          {error}
        </p>
      )}

      {canGenerate && (
        <button
          className="account-center__primary"
          type="button"
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy
            ? "正在生成…"
            : status?.allocated
              ? "作废旧码并重新生成"
              : "生成邀请码"}
        </button>
      )}
    </section>
  );
}
