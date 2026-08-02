import { Link } from "react-router-dom";
import { useAuthStore } from "@/account/auth";
import { PersonalInvitationPanel } from "./PersonalInvitationPanel";

export function AccountCenter() {
  const { user, profile, busy, error, signOut } = useAuthStore();

  return (
    <main className="account-center">
      <header className="account-center__header">
        <div>
          <p className="account-center__eyebrow">JOJO 看报</p>
          <h1>{profile?.display_name ?? "读者账号"}</h1>
          <p className="account-center__muted">{user?.email}</p>
        </div>
        <Link to="/archive">返回报刊馆藏</Link>
      </header>

      <PersonalInvitationPanel />

      {error && (
        <p className="account-center__error" role="alert">
          {error}
        </p>
      )}
      <button
        className="account-center__sign-out"
        type="button"
        disabled={busy}
        onClick={() => void signOut().catch(() => undefined)}
      >
        {busy ? "正在退出…" : "退出登录"}
      </button>
    </main>
  );
}
