import type { MobileTimesNewsItem } from "./times";
import { exactTimesArticleTime, timesSourceName } from "./times";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeTimesArticleHtml(value: string): string {
  return value
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, " $1=\"#\"");
}

function textBody(value: string): string {
  return value
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export function materializeTimesArticleAssets(news: MobileTimesNewsItem): string {
  let content = news.contentFormat === "html"
    ? sanitizeTimesArticleHtml(news.content || "")
    : textBody(news.content || "暂无正文。");
  for (const asset of news.assets) {
    const url = news.assetUrls?.[asset.id];
    if (!url || asset.type !== "image") continue;
    const figurePattern = new RegExp(`(<figure\\b[^>]*data-asset-id=(['"])${escapeRegExp(asset.id)}\\2[^>]*>)([\\s\\S]*?)(<\\/figure\\s*>)`, "gi");
    const image = `<img src="${escapeHtml(url)}" alt="${escapeHtml(asset.alt || asset.caption || "")}" loading="lazy" decoding="async">`;
    const caption = asset.caption ? `<figcaption>${escapeHtml(asset.caption)}</figcaption>` : "";
    content = content.replace(figurePattern, (_match, opening: string, _quote: string, inner: string, closing: string) => {
      // The fragment owns the active language's caption; asset metadata is
      // the original-language fallback only when no figure caption exists.
      const body = inner.replace(/<img\b[^>]*>/gi, "");
      return `${opening}${image}${body}${/<figcaption\b/i.test(body) ? "" : caption}${closing}`;
    });
  }
  return content;
}

export function createTimesArticleDocument(news: MobileTimesNewsItem, eInk = false): string {
  const body = materializeTimesArticleAssets(news);
  const translationBadge = news.usingTranslation ? '<span class="translation">AI 翻译</span>' : "";
  const colors = eInk
    ? { ink: "#000", muted: "#333", red: "#000", rule: "#777", paper: "#fff" }
    : { ink: "#202020", muted: "#68645f", red: "#8b1a1a", rule: "#d8d4cf", paper: "#fff" };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root{color-scheme:light;--ink:${colors.ink};--muted:${colors.muted};--red:${colors.red};--rule:${colors.rule};--paper:${colors.paper}}
    *{box-sizing:border-box}
    html,body{margin:0;background:var(--paper);color:var(--ink)}
    body{padding:26px 20px 54px;font-family:serif;font-size:17px;line-height:1.95;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}
    article{width:100%;max-width:760px;margin:0 auto}
    .meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:0 0 14px;color:var(--muted);font-family:sans-serif;font-size:11px;font-weight:700;line-height:1.8;letter-spacing:.04em;text-align:left;text-indent:0}
    .source{color:var(--red);font-weight:900}
    .translation{display:inline-block;margin:0;border:1px solid var(--red);padding:0 5px;color:var(--red);font-size:9px;font-weight:900;letter-spacing:0}
    h1{margin:0 0 28px;font-size:30px;line-height:1.3;font-weight:900;letter-spacing:-.02em}
    h2{margin:2em 0 .65em;font-size:23px;line-height:1.4} h3{margin:1.8em 0 .6em;font-size:20px}
    #article-body p{margin:1.05em 0;text-align:justify;text-indent:2em}
    blockquote{margin:1.5em 0;border-left:3px solid var(--red);padding-left:18px;color:var(--muted)}
    ul,ol{margin:1.2em 0;padding-left:1.6em} li{margin:.5em 0}
    figure{margin:2em 0} img{display:block;width:auto;max-width:100%;max-height:72vh;margin:0 auto;object-fit:contain;cursor:zoom-in}
    figcaption{margin-top:9px;color:var(--muted);font-family:sans-serif;font-size:12px;line-height:1.6;text-align:center}
    a{color:var(--red);font-weight:800;text-decoration:none;border-bottom:1px solid var(--red)}
    hr{height:1px;margin:2em 0;border:0;background:var(--rule)}
    ::selection{background:${eInk ? "#bbb" : "rgba(139,26,26,.18)"}}
    @media(min-width:720px){body{padding:38px 9vw 64px;font-size:18px}h1{font-size:38px}}
  </style>
</head>
<body>
  <article id="article">
    <p class="meta"><span><span class="source">${escapeHtml(timesSourceName(news.source))}</span> · 发布于 ${escapeHtml(exactTimesArticleTime(news.publishedAt))}</span>${translationBadge}</p>
    <h1>${escapeHtml(news.title)}</h1>
    <section id="article-body">${body}</section>
  </article>
  <script>
    (function(){
      var timer=0;
      function sendSelection(){
        clearTimeout(timer);
        timer=setTimeout(function(){
          var selection=window.getSelection();
          var quote=selection&&selection.toString().replace(/\\s+/g,' ').trim();
          var root=document.getElementById('article-body');
          if(!quote||!selection.rangeCount||!root.contains(selection.getRangeAt(0).commonAncestorContainer)){window.ReactNativeWebView.postMessage(JSON.stringify({type:'selection',quote:''}));return;}
          var range=selection.getRangeAt(0);
          var rect=range.getBoundingClientRect();
          var before=range.cloneRange();before.selectNodeContents(root);before.setEnd(range.startContainer,range.startOffset);
          var after=range.cloneRange();after.selectNodeContents(root);after.setStart(range.endContainer,range.endOffset);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'selection',quote:quote.slice(0,3000),
            prefix:before.toString().replace(/\\s+/g,' ').slice(-900),
            suffix:after.toString().replace(/\\s+/g,' ').slice(0,900),
            rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
            viewport:{width:window.innerWidth,height:window.innerHeight}
          }));
        },90);
      }
      document.addEventListener('selectionchange',sendSelection,{passive:true});
      window.addEventListener('scroll',sendSelection,{passive:true});
      window.addEventListener('resize',sendSelection,{passive:true});
      document.addEventListener('contextmenu',function(event){event.preventDefault();});
      document.addEventListener('click',function(event){
        var image=event.target.closest&&event.target.closest('figure[data-asset-id] img');
        if(image){
          event.preventDefault();
          var figure=image.closest('figure');
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'image',assetId:figure.getAttribute('data-asset-id'),caption:figure.querySelector('figcaption')?.textContent||image.alt}));
          return;
        }
        var link=event.target.closest&&event.target.closest('a[href]');
        if(!link)return;
        event.preventDefault();
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'link',url:link.href}));
      });
    })();
  </script>
</body>
</html>`;
}

export function createTimesImageDocument(url: string, caption: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'">
    <style>html,body{margin:0;background:#fff}body{min-height:100vh;display:flex;align-items:center;justify-content:center}img{width:100%;height:auto;object-fit:contain}</style>
    </head><body><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}"></body></html>`;
}
