import type { ReactNode } from "react";
import { AccountShell } from "./AccountShell";
import { Brand } from "./Brand";

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
      <article className="credential-sheet">
        <header className="credential-masthead">
          <Brand />
          <div className="credential-issue" aria-label="馆藏编号">
            <span>馆藏阅览证</span>
            <strong>第 01 号</strong>
            <span>二〇二六年</span>
          </div>
        </header>

        <div className="credential-band">
          <strong>读者登录登记</strong>
          <span>仅供已登记读者使用</span>
        </div>

        <div className="credential-grid">
          <aside className="credential-intro" aria-label="阅览说明">
            <span className="credential-intro__label">阅览须知</span>
            <div className="credential-intro__copy">
              <h1>登记读者身份<br />进入数字馆藏</h1>
              <ol className="reader-notes">
                <li><b>（一）</b><span>账号用于识别读者身份，登录后可以继续阅览馆藏。</span></li>
                <li><b>（二）</b><span>新读者登记暂未开放，已有账号可直接登录。</span></li>
              </ol>
            </div>
            <div className="archive-seal" aria-hidden="true">
              <span>JOJO</span>
              <strong>数字馆藏</strong>
              <small>二〇二六</small>
            </div>
          </aside>

          <section className="credential-form">
            <div className="credential-form__heading">
              <p>{eyebrow}</p>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
            {children}
          </section>
        </div>

        <footer className="credential-folio">
          <span>JOJO 数字馆藏 · 账号登记页</span>
          <span>内部编号 2026—01</span>
        </footer>
      </article>
    </AccountShell>
  );
}
