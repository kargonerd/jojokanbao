import type { ReactNode } from "react";
import { AccountShell } from "./AccountShell";

export function AuthScaffold({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <AccountShell>
      <div className="credential-grid">
        <section className="credential-intro" aria-label="JOJO 统一账号介绍">
          <div>
            <p className="font-sans text-[10px] font-bold tracking-[0.28em] text-cream/70 uppercase">JOJO Reader Pass</p>
            <h1 className="mt-8 max-w-md text-[clamp(2.1rem,5vw,4.4rem)] font-black leading-[1.08] tracking-[-0.045em] text-cream">
              一张读者证，<br />进入 JOJO。
            </h1>
            <p className="mt-6 max-w-sm text-sm leading-7 text-cream/75">
              账号用于识别读者身份，并承载后续的个人资料与阅读功能。
            </p>
          </div>
          <div className="reader-pass" aria-hidden="true">
            <div className="flex items-start justify-between gap-4">
              <span className="font-sans text-[9px] font-bold tracking-[0.24em] uppercase">Archive Access Card</span>
              <span className="font-sans text-[9px] tracking-widest">NO. 2026—0718</span>
            </div>
            <div className="mt-8 grid grid-cols-[52px_1fr] gap-4">
              <span className="flex h-[52px] items-center justify-center border border-cream/50 font-sans text-xl font-black">J</span>
              <div className="space-y-2 pt-1">
                <span className="block border-b border-cream/40" />
                <span className="block w-4/5 border-b border-cream/40" />
                <span className="block w-3/5 border-b border-cream/40" />
              </div>
            </div>
          </div>
        </section>

        <section className="credential-form">
          <div className="mb-9 flex items-start justify-between gap-4">
            <div>
              <p className="font-sans text-[10px] font-bold tracking-[0.25em] text-red uppercase">{eyebrow}</p>
              <h2 className="mt-3 text-3xl font-black tracking-[-0.03em]">{title}</h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted">{description}</p>
            </div>
            <span className="hidden border-t-2 border-red pt-2 font-sans text-[9px] font-bold tracking-[0.16em] text-red uppercase sm:block">
              Member<br />Access
            </span>
          </div>
          {children}
        </section>
      </div>
    </AccountShell>
  );
}
