import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-[54vh] max-w-4xl items-center justify-center px-5 py-10 text-center sm:py-16">
      <div>
        <h1 className="m-0 font-sans text-lg font-black tracking-[0.08em] text-red sm:text-2xl">
          404 Not Found
        </h1>
        <p className="m-0 mt-5 font-serif text-[clamp(1.75rem,4.5vw,3rem)] font-black leading-[1.35] tracking-[0.04em] text-ink sm:mt-6">
          前途是光明的，道路是曲折的
        </p>
        <Link
          to="/"
          className="mt-7 inline-flex items-center gap-2 font-sans text-xs font-bold tracking-[0.18em] text-red hover:text-red-dark sm:mt-8"
        >
          返回首页
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </main>
  );
}
