import { useState, type ChangeEvent, type FormEvent } from "react";
import { getProfileAvatarUrl } from "@jojo/auth";
import { Link, useNavigate } from "react-router-dom";
import { authClient, useAuthStore } from "../auth";
import { PersonalInvitationPanel } from "../components/PersonalInvitationPanel";

interface AccountCenterPageProps {
  userId: string;
}

export function AccountCenterPage({ userId }: AccountCenterPageProps) {
  const navigate = useNavigate();
  const {
    user,
    profile,
    busy,
    error,
    notice,
    signOut,
    uploadAvatar,
    changePassword,
    deleteAccount,
    clearFeedback,
  } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const displayName = profile?.display_name?.trim() || "代号待分配";
  const hasDisplayName = Boolean(profile?.display_name?.trim());
  const avatarUrl = getProfileAvatarUrl(authClient, profile?.avatar_path);

  const leaveAccount = async () => {
    try {
      await signOut();
      navigate("/", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    clearFeedback();
    setLocalError(null);
    if (file.size > 2 * 1024 * 1024) {
      setLocalError("头像文件不能超过 2 MB。");
      return;
    }
    try {
      await uploadAvatar(file);
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearFeedback();
    setLocalError(null);
    if (newPassword.length < 8) {
      setLocalError("新密码至少需要 8 位字符。");
      return;
    }
    if (newPassword !== newPasswordConfirmation) {
      setLocalError("两次输入的新密码不一致。");
      return;
    }
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const removeAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearFeedback();
    setLocalError(null);
    if (deletePhrase !== "注销账号") {
      setLocalError("请输入“注销账号”确认这项操作。");
      return;
    }
    try {
      await deleteAccount(deletePassword);
      navigate("/", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <main className="min-h-screen bg-paper px-5 py-8 text-ink sm:px-8 sm:py-12">
      <header className="mx-auto flex w-full max-w-[64rem] items-center justify-between border-b border-ink pb-4">
        <Link
          to="/"
          aria-label="返回 JOJO 首页"
          className="inline-flex items-center gap-2 font-serif text-sm font-black tracking-[0.14em] text-ink no-underline hover:text-red"
        >
          <span aria-hidden="true" className="text-red">★</span>
          JOJO 看报
        </Link>
        <button
          type="button"
          disabled={busy}
          onClick={() => void leaveAccount()}
          className="border-0 border-b border-transparent bg-transparent px-0 py-1 font-serif text-xs font-bold tracking-[0.08em] text-muted hover:border-red hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60"
        >
          退出登录
        </button>
      </header>

      <article className="mx-auto w-full max-w-[54rem] py-9 sm:py-12">
        <p className="m-0 font-sans text-[0.65rem] font-black uppercase tracking-[0.22em] text-red">Account dossier / 账号档案</p>
        <h1 className="mb-8 mt-3 font-serif text-3xl font-black tracking-[0.06em] sm:text-4xl">你的统一账号</h1>

        {(localError || error || notice) && (
          <p
            className={`mb-6 border-l-4 px-4 py-3 text-sm font-bold leading-7 ${localError || error ? "border-red bg-[#fbf3f3] text-red" : "border-ink bg-[#f5f3ee] text-ink"}`}
            role={localError || error ? "alert" : "status"}
          >
            {localError ?? error ?? notice}
          </p>
        )}

        <div className="border-y border-rule">
          <section aria-labelledby="reader-name-title" className="grid gap-5 py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
            <h2 id="reader-name-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">账号资料</h2>
            <div className="grid gap-5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
              <label className="group relative block h-32 w-24 cursor-pointer overflow-hidden border-2 border-red bg-[#f5efe6] focus-within:outline focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-red">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="当前头像" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center font-serif text-3xl font-black text-red">{displayName.slice(0, 1)}</span>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-ink/90 py-1 text-center font-sans text-[0.6rem] font-bold text-white">更换头像</span>
                <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void chooseAvatar(event)} />
              </label>
              <div>
                <strong className={`block font-serif text-3xl font-black tracking-[0.08em] ${hasDisplayName ? "text-ink" : "text-muted"}`}>{displayName}</strong>
                <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">读者代号由系统分配，暂不可修改</p>
                <p className="mb-0 mt-4 break-all font-sans text-sm font-bold text-ink">{user?.email || "—"}</p>
                <p className="mb-0 mt-1 text-xs font-bold text-muted">登录邮箱不可修改</p>
              </div>
            </div>
          </section>

          <PersonalInvitationPanel userId={userId} />

          <section aria-labelledby="password-title" className="grid gap-5 border-t border-rule py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
            <div>
              <h2 id="password-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">修改密码</h2>
              <p className="mb-0 mt-3 text-xs font-bold leading-6 text-muted">修改后其他设备将退出登录。</p>
            </div>
            <form className="account-security-form" onSubmit={savePassword}>
              <label><span>当前密码</span><input type="password" autoComplete="current-password" value={currentPassword} disabled={busy} required onChange={(event) => setCurrentPassword(event.target.value)} /></label>
              <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} value={newPassword} disabled={busy} required onChange={(event) => setNewPassword(event.target.value)} /></label>
              <label><span>再次输入新密码</span><input type="password" autoComplete="new-password" minLength={8} value={newPasswordConfirmation} disabled={busy} required onChange={(event) => setNewPasswordConfirmation(event.target.value)} /></label>
              <button type="submit" disabled={busy}>{busy ? "处理中…" : "修改密码"}</button>
            </form>
          </section>

          <section aria-labelledby="delete-title" className="grid gap-5 border-t border-red py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
            <div>
              <h2 id="delete-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">注销账号</h2>
              <p className="mb-0 mt-3 text-xs font-bold leading-6 text-muted">账号、资料和头像会永久删除，无法撤销。</p>
            </div>
            <form className="account-security-form account-security-form--danger" onSubmit={removeAccount}>
              <label><span>当前密码</span><input type="password" autoComplete="current-password" value={deletePassword} disabled={busy} required onChange={(event) => setDeletePassword(event.target.value)} /></label>
              <label><span>输入“注销账号”确认</span><input type="text" autoComplete="off" value={deletePhrase} disabled={busy} required onChange={(event) => setDeletePhrase(event.target.value)} /></label>
              <button type="submit" disabled={busy}>永久注销账号</button>
            </form>
          </section>
        </div>
      </article>
    </main>
  );
}
