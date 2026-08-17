import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../auth";
import { PersonalInvitationPanel } from "../components/PersonalInvitationPanel";

interface AccountCenterPageProps {
  userId: string;
}

export function AccountCenterPage({ userId }: AccountCenterPageProps) {
  const navigate = useNavigate();
  const { profile, busy, error, signOut } = useAuthStore();
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
        <div className="border-y border-rule">
          <section
            aria-labelledby="reader-name-title"
            className="grid gap-3 py-7 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8"
          >
            <h2
              id="reader-name-title"
              className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red"
            >
              读者代号
            </h2>
            <div>
              <strong className={`block font-serif text-3xl font-black tracking-[0.08em] ${hasDisplayName ? "text-ink" : "text-muted"}`}>
                {displayName}
              </strong>
              <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">
                {hasDisplayName ? "暂不可修改" : "正在分配，请稍后刷新"}
              </p>
              {!hasDisplayName && error && (
                <p className="mb-0 mt-3 border-l-2 border-red pl-3 text-sm font-bold leading-7 text-red" role="alert">
                  {error}
                </p>
              )}
            </div>
          </section>

          <PersonalInvitationPanel userId={userId} />
        </div>
      </article>
    </main>
  );
}
