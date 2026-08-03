import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../auth";
import { PersonalInvitationPanel } from "../components/PersonalInvitationPanel";

interface AccountCenterPageProps {
  userId: string;
}

export function AccountCenterPage({ userId }: AccountCenterPageProps) {
  const navigate = useNavigate();
  const { profile, busy, error, signOut } = useAuthStore();
  const displayName = profile?.display_name?.trim() || "昵称待分配";
  const hasDisplayName = Boolean(profile?.display_name?.trim());

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
        <button
          type="button"
          disabled={busy}
          onClick={() => void leaveAccount()}
          className="border-0 border-b border-transparent bg-transparent px-0 py-1 font-serif text-xs font-bold tracking-[0.08em] text-muted hover:border-red hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60"
        >
          退出登录
        </button>
      </header>

      <article className="mx-auto w-full max-w-[46rem] py-14 sm:py-20">
        <header>
          <p className="m-0 font-sans text-[0.68rem] font-black tracking-[0.22em] text-red">
            个人账号
          </p>
          <h1 className="mb-0 mt-3 font-serif text-4xl font-black tracking-[0.12em] sm:text-5xl">
            读者身份
          </h1>
          <p className="mb-0 mt-5 text-sm font-bold leading-7 text-muted">
            查看你的读者昵称与个人邀请凭证。
          </p>
        </header>

        <section
          aria-labelledby="reader-name-title"
          className="mt-10 border-y-2 border-red py-7 sm:mt-12 sm:py-9"
        >
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-end sm:gap-10">
            <div>
              <p
                id="reader-name-title"
                className="m-0 font-sans text-xs font-black tracking-[0.16em] text-red"
              >
                读者昵称
              </p>
              <strong className={`mt-3 block font-serif text-4xl font-black tracking-[0.12em] sm:text-5xl ${hasDisplayName ? "text-ink" : "text-muted"}`}>
                {displayName}
              </strong>
            </div>
            <p className="m-0 border-l border-rule pl-5 text-xs font-bold leading-6 text-muted">
              {hasDisplayName
                ? "昵称取自全球动植物名称，目前暂不可修改。"
                : "账号昵称尚未完成分配，请稍后刷新页面。"}
            </p>
          </div>
          {!hasDisplayName && error && (
            <p className="mb-0 mt-5 border-l-2 border-red pl-4 text-sm font-bold leading-7 text-red" role="alert">
              {error}
            </p>
          )}
        </section>

        <div className="mt-14 sm:mt-20">
        <PersonalInvitationPanel userId={userId} />
        </div>
      </article>
    </main>
  );
}
