import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../auth";
import { PersonalInvitationPanel } from "../components/PersonalInvitationPanel";

export function AccountCenterPage() {
  const navigate = useNavigate();
  const { user, profile, busy, signOut } = useAuthStore();

  const leaveAccount = async () => {
    try {
      await signOut();
      navigate("/archive", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <main className="min-h-screen bg-paper px-5 py-8 text-ink sm:px-8 sm:py-12">
      <header className="mx-auto flex w-full max-w-[64rem] items-center justify-between border-b border-ink pb-4">
        <Link
          to="/archive"
          aria-label="返回 JOJO 看报首页"
          className="inline-flex items-center gap-2 font-serif text-sm font-black tracking-[0.14em] text-ink no-underline hover:text-red"
        >
          <span aria-hidden="true" className="text-red">★</span>
          JOJO 看报
        </Link>
        <div className="flex items-center gap-4 font-serif text-xs font-bold tracking-[0.08em]">
          <span>{profile?.display_name ?? "读者"}</span>
          <span aria-hidden="true" className="text-rule-dark">·</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void leaveAccount()}
            className="border-0 border-b border-transparent bg-transparent px-0 py-1 text-muted hover:border-red hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60"
          >
            退出登录
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[38rem] py-16 sm:py-24">
        <PersonalInvitationPanel userId={user!.id} />
      </div>
    </main>
  );
}
