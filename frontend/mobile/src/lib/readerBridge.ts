interface ReaderAppearance {
  eInkRelease: boolean;
  textScale: number;
}

export function readerAppearanceScript({ eInkRelease, textScale }: ReaderAppearance): string {
  return `(() => {
    const root = document.documentElement;
    if (!root) return true;
    root.classList.toggle('jojo-native-eink', ${JSON.stringify(eInkRelease)});
    root.style.setProperty('--jojo-native-text-scale', ${JSON.stringify(String(textScale))});
    true;
  })();`;
}

export function readerBootstrapScript(appearance: ReaderAppearance): string {
  return `(() => {
    const STYLE_ID = 'jojo-native-reader-style';
    const BRIDGE_KEY = '__jojoNativeReaderBridge';
    const post = (payload) => {
      try { window.ReactNativeWebView?.postMessage(JSON.stringify(payload)); } catch (_) {}
    };
    let lastPage = '';
    let pageObserver;

    const applyAppearance = () => {
      ${readerAppearanceScript(appearance)}
    };
    const installStyle = () => {
      if (!document.head) return false;
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = \`
          .platform-header, [data-jojo-native-hidden] { display: none !important; }
          .platform-shell > main { min-height: 100vh !important; }
          html { font-size: calc(16px * var(--jojo-native-text-scale, 1)); }
          html, body { overscroll-behavior: none; }
          html.jojo-native-eink { filter: grayscale(1) !important; }
          html.jojo-native-eink *, html.jojo-native-eink *::before, html.jojo-native-eink *::after {
            animation: none !important;
            transition: none !important;
            box-shadow: none !important;
          }
          html.jojo-native-eink body { background: #fff !important; color: #000 !important; }
          html.jojo-native-eink canvas, html.jojo-native-eink img { filter: grayscale(1) contrast(1.18); }
          html.jojo-native-eink [data-reader-toolbar] { border-color: #000 !important; }
        \`;
        document.head.appendChild(style);
      }
      return true;
    };
    const hideWebHeader = () => {
      document.querySelectorAll('.platform-header, header').forEach((element) => {
        if (element.matches('.platform-header') || element.querySelector('nav')) {
          element.setAttribute('data-jojo-native-hidden', '');
        }
      });
    };
    const publishPage = () => {
      const status = document.querySelector('[data-reader-page-status]');
      const match = status?.textContent?.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
      if (!match || match[0] === lastPage) return;
      lastPage = match[0];
      post({ type: 'page', current: Number(match[1]), total: Number(match[2]), url: location.href });
    };
    const attachPageObserver = () => {
      const status = document.querySelector('[data-reader-page-status]');
      if (!status) return false;
      pageObserver?.disconnect();
      pageObserver = new MutationObserver(publishPage);
      pageObserver.observe(status, { childList: true, subtree: true, characterData: true });
      publishPage();
      return true;
    };
    const install = () => {
      applyAppearance();
      if (!installStyle()) return false;
      hideWebHeader();
      attachPageObserver();
      return true;
    };

    if (!window[BRIDGE_KEY]) {
      window[BRIDGE_KEY] = true;
      const documentObserver = new MutationObserver(() => {
        if (!install()) return;
        hideWebHeader();
        if (!pageObserver) attachPageObserver();
      });
      const start = () => {
        install();
        documentObserver.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
      addEventListener('hashchange', () => { publishPage(); post({ type: 'url', url: location.href }); });
      addEventListener('popstate', () => post({ type: 'url', url: location.href }));
      addEventListener('load', () => {
        install();
        publishPage();
        post({ type: 'ready', url: location.href });
      });
      if (document.readyState === 'complete') {
        install();
        publishPage();
        post({ type: 'ready', url: location.href });
      }
    } else {
      install();
    }
    true;
  })();`;
}

export function parseArchiveReaderUrl(url: string): { publication: string; issueId: string } | null {
  const match = /\/archive\/([a-z]+)\/(\d{6,8})(?:[/?#]|$)/i.exec(url);
  return match?.[1] && match[2] ? { publication: match[1].toLowerCase(), issueId: match[2] } : null;
}
