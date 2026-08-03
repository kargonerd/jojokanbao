import type { ReactNode } from "react";

export function ConfirmationShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-5 py-12 text-ink">
      <section className="w-full max-w-[34rem] border border-rule border-t-4 border-t-red bg-paper px-7 py-9 shadow-[6px_6px_0_rgba(139,26,26,.08)] sm:px-11 sm:py-11">
        <img
          src="/brand/jojo-kanbao-mark.svg"
          width="64"
          height="64"
          alt=""
          className="mb-7 block h-16 w-16"
        />
        <p className="mb-3 text-xs font-bold tracking-[0.18em] text-red">
          账号登记
        </p>
        {children}
      </section>
    </main>
  );
}
