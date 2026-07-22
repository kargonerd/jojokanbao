import { getProfileAvatarUrl } from "@jojo/auth";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { authClient, useAuthStore } from "@/auth";
import { AccountShell } from "@/components/AccountShell";
import { Seal } from "@/components/Brand";
import { AuthField, FormFeedback, SubmitButton } from "@/components/FormParts";

const ALLOWED_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export function AccountPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user, profile, updateProfile, uploadAvatar, signOut, busy, error, notice, clearFeedback } = useAuthStore();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(profile?.display_name ?? "");
  }, [profile?.display_name]);

  const avatarUrl = getProfileAvatarUrl(authClient, profile?.avatar_path);
  const fallbackInitial = (profile?.display_name || user?.email || "J").trim().slice(0, 1).toUpperCase();

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    try {
      await updateProfile({ displayName });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const handleAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    clearFeedback();
    if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
      setLocalError("头像仅支持 JPG、PNG 或 WebP 格式。");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setLocalError("头像文件不能超过 2 MB。");
      return;
    }
    setLocalError(null);
    try {
      await uploadAvatar(file);
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <AccountShell compact>
      <section className="account-heading">
        <div>
          <p className="font-sans text-[10px] font-bold tracking-[0.26em] text-red uppercase">Account dossier / 账号档案</p>
          <h1 className="mt-3 text-3xl font-black tracking-[-0.04em] md:text-4xl">你的统一账号</h1>
          <p className="mt-3 text-sm leading-6 text-muted">资料在账号中心统一维护，接入的服务无需重复注册。</p>
        </div>
        <button type="button" onClick={handleSignOut} disabled={busy} className="btn btn-outline h-10">退出登录</button>
      </section>

      <div className="account-dashboard">
        <section className="profile-card bg-paper" aria-labelledby="profile-title">
          <div className="profile-card__stripe" />
          <div className="p-6 md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-6 border-b border-rule pb-7">
              <div className="flex items-center gap-5">
                <button
                  type="button"
                  className="avatar-frame group relative flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden border border-rule-dark bg-cream"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="更换头像"
                  disabled={busy}
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="账号头像" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-3xl font-black text-red">{fallbackInitial}</span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-ink/85 py-1.5 font-sans text-[9px] tracking-widest text-paper opacity-0 transition-opacity group-hover:opacity-100">
                    更换
                  </span>
                </button>
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatar} />
                <div>
                  <p className="text-xl font-black">{profile?.display_name || "未设置名称"}</p>
                  <p className="mt-2 font-sans text-xs text-muted">{user?.email}</p>
                  <p className="mt-3 font-sans text-[9px] tracking-[0.18em] text-red uppercase">Verified JOJO Member</p>
                </div>
              </div>
              <Seal />
            </div>

            <form className="mt-7 space-y-5" onSubmit={handleSave}>
              <h2 id="profile-title" className="text-lg font-black">基本资料</h2>
              <FormFeedback error={localError ?? error} notice={notice} />
              <AuthField
                label="显示名称"
                name="displayName"
                autoComplete="nickname"
                maxLength={50}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                hint="最多 50 个字符"
              />
              <AuthField label="登录邮箱" type="email" value={user?.email ?? ""} disabled readOnly />
              <div className="max-w-[200px]">
                <SubmitButton busy={busy}>保存资料</SubmitButton>
              </div>
            </form>
          </div>
        </section>

        <aside className="space-y-5">
          <section className="border border-rule-dark bg-paper p-6">
            <p className="font-sans text-[9px] font-bold tracking-[0.22em] text-red uppercase">Identity</p>
            <h2 className="mt-3 text-lg font-black">身份状态</h2>
            <dl className="mt-5 space-y-4 text-sm">
              <div className="flex justify-between gap-4 border-b border-rule pb-3">
                <dt className="text-muted">邮箱</dt>
                <dd className="font-bold text-red">已验证</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-rule pb-3">
                <dt className="text-muted">账号类型</dt>
                <dd className="font-bold">普通用户</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">服务状态</dt>
                <dd className="font-bold">可用</dd>
              </div>
            </dl>
          </section>

          <section className="connected-services border border-red bg-red p-6 text-cream">
            <p className="font-sans text-[9px] font-bold tracking-[0.22em] text-cream/65 uppercase">Connected services</p>
            <h2 className="mt-3 text-lg font-black">已接入服务</h2>
            <div className="mt-5 border-y border-cream/25 py-4">
              <p className="font-bold">JOJO 看报</p>
              <p className="mt-1 text-xs leading-5 text-cream/65">账号基础已就绪，业务接入可独立进行。</p>
            </div>
            <p className="mt-4 text-xs leading-5 text-cream/65">后续服务会继续使用这一身份，无需重新注册。</p>
          </section>
        </aside>
      </div>
    </AccountShell>
  );
}
