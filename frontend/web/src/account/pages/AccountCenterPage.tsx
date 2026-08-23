import { Modal } from "@jojo/ui";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../auth";
import { PersonalInvitationPanel } from "../components/PersonalInvitationPanel";

interface AccountCenterPageProps {
  userId: string;
}

type AccountDialog = "password" | "delete" | null;

const rowActionClass =
  "shrink-0 border border-red bg-paper px-4 py-2 font-serif text-xs font-black tracking-[0.08em] text-red transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none";

const primaryButtonClass =
  "min-h-11 border border-red bg-red px-5 font-serif text-sm font-black tracking-[0.08em] text-white transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none";

const secondaryButtonClass =
  "min-h-11 border border-rule-dark bg-paper px-5 font-serif text-sm font-black tracking-[0.08em] text-ink hover:border-red hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60";

export function AccountCenterPage({ userId }: AccountCenterPageProps) {
  const navigate = useNavigate();
  const {
    user,
    profile,
    busy,
    error,
    notice,
    signOut,
    changePassword,
    deleteAccount,
    clearFeedback,
  } = useAuthStore();
  const [activeDialog, setActiveDialog] = useState<AccountDialog>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const displayName = profile?.display_name?.trim() || "代号待分配";
  const hasDisplayName = Boolean(profile?.display_name?.trim());

  const leaveAccount = async () => {
    try {
      await signOut();
      navigate("/", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const openDialog = (dialog: Exclude<AccountDialog, null>) => {
    clearFeedback();
    setLocalError(null);
    if (dialog === "password") {
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
    } else {
      setDeletePassword("");
      setDeletePhrase("");
    }
    setActiveDialog(dialog);
  };

  const closeDialog = () => {
    if (busy) return;
    clearFeedback();
    setLocalError(null);
    setActiveDialog(null);
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
      setActiveDialog(null);
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

  const dialogFeedback = localError ?? error;

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] px-5 text-ink sm:px-8">
      <article className="mx-auto w-full max-w-[54rem] py-9 sm:py-12">
        {!activeDialog && (error || notice) && (
          <p
            className={`mb-6 border-l-4 px-4 py-3 text-sm font-bold leading-7 ${error ? "border-red bg-[#fbf3f3] text-red" : "border-ink bg-[#f5f3ee] text-ink"}`}
            role={error ? "alert" : "status"}
          >
            {error ?? notice}
          </p>
        )}

        <div className="border-y border-rule">
          <section aria-labelledby="reader-name-title" className="grid gap-4 py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
            <h2 id="reader-name-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">账号资料</h2>
            <div>
              <strong className={`block font-serif text-3xl font-black tracking-[0.08em] ${hasDisplayName ? "text-ink" : "text-muted"}`}>{displayName}</strong>
              <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">
                {hasDisplayName ? "读者代号由系统分配，暂不可修改" : "正在分配读者代号，请稍后刷新"}
              </p>
              <dl className="mb-0 mt-5 grid gap-1 border-t border-rule pt-4 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
                <dt className="font-sans text-xs font-bold text-muted">登录邮箱</dt>
                <dd className="m-0 break-all font-sans text-sm font-bold text-ink">{user?.email || "—"}</dd>
              </dl>
            </div>
          </section>

          <PersonalInvitationPanel userId={userId} />

          <section aria-labelledby="security-title" className="grid gap-4 border-t border-rule py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
            <h2 id="security-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">账号与安全</h2>
            <div className="divide-y divide-rule border-y border-rule">
              <div className="flex items-center justify-between gap-5 py-4">
                <div>
                  <h3 className="m-0 font-serif text-base font-black text-ink">修改密码</h3>
                  <p className="mb-0 mt-1 text-xs font-bold leading-6 text-muted">修改后，其他设备会退出登录。</p>
                </div>
                <button type="button" disabled={busy} onClick={() => openDialog("password")} className={rowActionClass}>修改密码</button>
              </div>
              <div className="flex items-center justify-between gap-5 py-4">
                <div>
                  <h3 className="m-0 font-serif text-base font-black text-ink">退出登录</h3>
                  <p className="mb-0 mt-1 text-xs font-bold leading-6 text-muted">只退出当前设备。</p>
                </div>
                <button type="button" disabled={busy} onClick={() => void leaveAccount()} className={rowActionClass}>退出登录</button>
              </div>
            </div>
          </section>

          <section aria-labelledby="delete-title" className="grid gap-4 border-t border-red py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
            <h2 id="delete-title" className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red">危险操作</h2>
            <div className="flex items-center justify-between gap-5">
              <div>
                <h3 className="m-0 font-serif text-base font-black text-red">注销账号</h3>
                <p className="mb-0 mt-1 text-xs font-bold leading-6 text-muted">账号及相关数据会永久删除，无法撤销。</p>
              </div>
              <button type="button" disabled={busy} onClick={() => openDialog("delete")} className={rowActionClass}>注销账号</button>
            </div>
          </section>
        </div>
      </article>

      <Modal open={activeDialog === "password"} onClose={closeDialog}>
        <section role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-5 border-b border-rule pb-4">
            <div>
              <h2 id="password-dialog-title" className="m-0 font-serif text-2xl font-black text-ink">修改密码</h2>
              <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">保存后，其他设备会退出登录。</p>
            </div>
            <button type="button" aria-label="关闭修改密码" disabled={busy} onClick={closeDialog} className="border-0 bg-transparent p-1 text-2xl leading-none text-muted hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-red">×</button>
          </div>

          {dialogFeedback && <p role="alert" className="mb-0 mt-5 border-l-4 border-red bg-[#fbf3f3] px-4 py-3 text-sm font-bold leading-6 text-red">{dialogFeedback}</p>}

          <form className="mt-6 grid gap-4" onSubmit={savePassword}>
            <label className="grid gap-2 font-sans text-xs font-bold text-ink"><span>当前密码</span><input autoFocus type="password" autoComplete="current-password" value={currentPassword} disabled={busy} required onChange={(event) => setCurrentPassword(event.target.value)} className="min-h-11 border border-ink bg-paper px-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red" /></label>
            <label className="grid gap-2 font-sans text-xs font-bold text-ink"><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} value={newPassword} disabled={busy} required onChange={(event) => setNewPassword(event.target.value)} className="min-h-11 border border-ink bg-paper px-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red" /></label>
            <label className="grid gap-2 font-sans text-xs font-bold text-ink"><span>再次输入新密码</span><input type="password" autoComplete="new-password" minLength={8} value={newPasswordConfirmation} disabled={busy} required onChange={(event) => setNewPasswordConfirmation(event.target.value)} className="min-h-11 border border-ink bg-paper px-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red" /></label>
            <div className="mt-2 flex justify-end gap-3 border-t border-rule pt-5">
              <button type="button" disabled={busy} onClick={closeDialog} className={secondaryButtonClass}>取消</button>
              <button type="submit" disabled={busy} className={primaryButtonClass}>{busy ? "处理中…" : "保存新密码"}</button>
            </div>
          </form>
        </section>
      </Modal>

      <Modal open={activeDialog === "delete"} onClose={closeDialog}>
        <section role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-5 border-b border-red pb-4">
            <div>
              <h2 id="delete-dialog-title" className="m-0 font-serif text-2xl font-black text-red">注销账号</h2>
              <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">这项操作无法撤销，请再次确认身份。</p>
            </div>
            <button type="button" aria-label="关闭注销账号" disabled={busy} onClick={closeDialog} className="border-0 bg-transparent p-1 text-2xl leading-none text-muted hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-red">×</button>
          </div>

          {dialogFeedback && <p role="alert" className="mb-0 mt-5 border-l-4 border-red bg-[#fbf3f3] px-4 py-3 text-sm font-bold leading-6 text-red">{dialogFeedback}</p>}

          <form className="mt-6 grid gap-4" onSubmit={removeAccount}>
            <label className="grid gap-2 font-sans text-xs font-bold text-ink"><span>当前密码</span><input autoFocus type="password" autoComplete="current-password" value={deletePassword} disabled={busy} required onChange={(event) => setDeletePassword(event.target.value)} className="min-h-11 border border-ink bg-paper px-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red" /></label>
            <label className="grid gap-2 font-sans text-xs font-bold text-ink"><span>输入“注销账号”确认</span><input type="text" autoComplete="off" value={deletePhrase} disabled={busy} required onChange={(event) => setDeletePhrase(event.target.value)} className="min-h-11 border border-ink bg-paper px-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red" /></label>
            <div className="mt-2 flex justify-end gap-3 border-t border-rule pt-5">
              <button type="button" disabled={busy} onClick={closeDialog} className={secondaryButtonClass}>取消</button>
              <button type="submit" disabled={busy} className={primaryButtonClass}>{busy ? "处理中…" : "永久注销账号"}</button>
            </div>
          </form>
        </section>
      </Modal>
    </main>
  );
}
