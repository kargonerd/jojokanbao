import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../auth";
import { PersonalInvitationPanel } from "../components/PersonalInvitationPanel";

const registrationYear = new Intl.DateTimeFormat("zh-CN-u-nu-hanidec", {
  year: "numeric",
}).format(new Date());

export function AccountCenterPage() {
  const navigate = useNavigate();
  const {
    user,
    profile,
    busy,
    error,
    notice,
    clearFeedback,
    updateProfile,
    signOut,
  } = useAuthStore();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(profile?.display_name ?? "");
  }, [profile?.display_name]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearFeedback();
    const nextName = displayName.trim();
    if (!nextName) {
      setValidationError("昵称不能为空。");
      return;
    }
    if (Array.from(nextName).length > 50) {
      setValidationError("昵称不能超过 50 个字符。");
      return;
    }
    setValidationError(null);
    try {
      await updateProfile({ displayName: nextName });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const leaveAccount = async () => {
    try {
      await signOut();
      navigate("/archive", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <main className="account-center-page">
      <header className="account-center-masthead">
        <Link to="/archive" aria-label="返回 JOJO 看报">
          <span aria-hidden="true">★</span>
          JOJO 看报
        </Link>
        <button type="button" disabled={busy} onClick={() => void leaveAccount()}>
          退出登录
        </button>
      </header>

      <article className="account-ledger">
        <header className="account-ledger__title">
          <div>
            <span>READER RECORD · 01</span>
            <h1>读者资料</h1>
          </div>
          <p>这本书属于</p>
        </header>

        <div className="account-ledger__body">
          <section className="account-profile" aria-labelledby="profile-title">
            <header className="account-section-heading">
              <div>
                <span>登记事项</span>
                <h2 id="profile-title">账号资料</h2>
              </div>
              <b>{profile?.display_name ?? "读者"}</b>
            </header>

            <form onSubmit={saveProfile}>
              <div className="account-profile__field">
                <label htmlFor="account-email">邮箱</label>
                <input id="account-email" type="email" value={user?.email ?? ""} readOnly />
                <small>登录邮箱不可在此修改</small>
              </div>
              <div className="account-profile__field">
                <label htmlFor="account-display-name">昵称</label>
                <input
                  id="account-display-name"
                  type="text"
                  value={displayName}
                  maxLength={50}
                  autoComplete="nickname"
                  disabled={busy}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <small>初次登记时由全球动植物名称随机生成</small>
              </div>

              {(validationError || error || notice) && (
                <p
                  className={`account-profile__feedback${validationError || error ? " account-profile__feedback--error" : ""}`}
                  role={validationError || error ? "alert" : "status"}
                >
                  {validationError ?? error ?? notice}
                </p>
              )}

              <button type="submit" disabled={busy || displayName.trim() === profile?.display_name}>
                {busy ? "正在保存…" : "保存昵称"}
              </button>
            </form>
          </section>

          <PersonalInvitationPanel userId={user!.id} />
        </div>

        <footer className="account-ledger__footer">
          <span>登记日期：{registrationYear}</span>
          <span>资料可随时修改</span>
        </footer>
      </article>
    </main>
  );
}
