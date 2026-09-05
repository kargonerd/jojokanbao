import { useEffect, useRef } from "react";
import "./download.css";

export function IphoneInstallPage() {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "iPhone 安装说明 · JOJO 看报";
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView?.({ block: "start" });
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <main className="client-download-page iphone-install-page">
      <section className="web-app-install" aria-labelledby="web-app-install-title">
        <header>
          <h1 id="web-app-install-title" ref={headingRef} tabIndex={-1}>
            <span className="iphone-install-device">在 iPhone 上</span>
            添加到主屏幕
          </h1>
        </header>
        <ol role="list">
          <li>
            <span className="iphone-install-number" aria-hidden="true">01</span>
            <div>
              <h2>打开 Safari</h2>
              <p>用 iPhone 的 Safari 打开本站。</p>
            </div>
          </li>
          <li>
            <span className="iphone-install-number" aria-hidden="true">02</span>
            <div>
              <h2>打开分享菜单</h2>
              <p>点按分享按钮，选择“添加到主屏幕”。</p>
            </div>
          </li>
          <li>
            <span className="iphone-install-number" aria-hidden="true">03</span>
            <div>
              <h2>确认添加</h2>
              <p>如果看到“打开为 Web App”，保持开启，再点“添加”。</p>
            </div>
          </li>
        </ol>
      </section>
    </main>
  );
}
