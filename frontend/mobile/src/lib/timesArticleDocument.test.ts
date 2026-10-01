import type { MobileTimesNewsItem } from "./times";
import { describe, expect, it } from "vitest";
import { createTimesApplyAnnotationsScript, createTimesArticleDocument, materializeTimesArticleAssets, sanitizeTimesArticleHtml } from "./timesArticleDocument";

describe("mobile times article document", () => {
  it.each([false, true])("limits paragraph indentation to the article body (eInk=%s)", (eInk) => {
    const news: MobileTimesNewsItem = {
      id: "nyt:layout", title: "新闻标题", contentStatus: "full",
      publishedAt: "2026-09-06T15:19:00.000Z", issueDate: "20260906",
      language: "zh-CN", originalLanguage: "en", translationAvailable: true, usingTranslation: true,
      source: { id: "nyt", name: "The New York Times", language: "en" },
      articleObject: "content/newspapers/nyt/articles/layout.jox",
      contentFormat: "html", content: "<p>正文保留首行缩进。</p>", assets: [],
    };
    const document = createTimesArticleDocument(news, eInk);
    const styles = document.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styles).toMatch(/#article-body p\{[^}]*text-indent:2em/);
    expect(styles).not.toMatch(/(?:^|\})\s*p\s*\{/);
    expect(styles).toMatch(/\.meta\{[^}]*text-align:left/);
    expect(styles).toMatch(/\.meta\{[^}]*text-indent:0/);
    expect(document).toContain('<span class="source">The New York Times</span>');
    expect(document).toContain('<span class="translation">AI 翻译</span>');
  });

  it("anchors saved underlines inside the article script", () => {
    const news: MobileTimesNewsItem = {
      id: "news-1", title: "标题", contentStatus: "full",
      publishedAt: "2026-09-03T00:00:00.000Z", issueDate: "20260903",
      language: "zh-CN", originalLanguage: "en", translationAvailable: false, usingTranslation: false,
      source: { id: "nyt", name: "The New York Times", language: "en" },
      articleObject: "content/newspapers/nyt/articles/a.jox",
      contentFormat: "text", content: "正文内容。", assets: [],
    };
    const document = createTimesArticleDocument(news, false);
    const styles = document.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styles).toMatch(/mark\[data-annotation-id\]\{[^}]*text-decoration-line:underline/);
    // The headline sits inside the selection root so it can be underlined too.
    expect(document).toMatch(/<section id="article-body"><h1>/);
    expect(document).toContain("window.__jojoTimesApplyAnnotations");
    expect(document).toContain("window.__jojoTimesRemoveAnnotation");
    expect(document).toContain("locateAnnotationQuote");
    expect(document).toContain("start:absoluteOffset(root,range.startContainer,range.startOffset)");
    expect(document).toContain("type:'annotation'");
  });

  it("escapes annotation markup when injecting underline scripts", () => {
    const script = createTimesApplyAnnotationsScript([{ id: "a1", start: 3, end: 5, quote: "</script>正文" }]);
    expect(script).toContain("__jojoTimesApplyAnnotations");
    expect(script).toContain("<\\/script>");
    expect(script).not.toContain("</script>正文");
  });

  it("removes executable publisher markup", () => {    const safe = sanitizeTimesArticleHtml('<p onclick="steal()">正文</p><script>steal()</script><a href="javascript:steal()">链接</a>');
    expect(safe).toContain("正文");
    expect(safe).not.toContain("onclick");
    expect(safe).not.toContain("<script");
    expect(safe).not.toContain("javascript:");
  });

  it("materializes archived images and installs the native selection bridge", () => {
    const news = {
      id: "news-1",
      title: "标题",
      contentStatus: "full",
      publishedAt: "2026-09-03T00:00:00.000Z",
      issueDate: "20260903",
      language: "zh-CN",
      originalLanguage: "en",
      translationAvailable: true,
      usingTranslation: true,
      source: { id: "example", name: "Example", language: "en" },
      articleObject: "content/newspapers/example/articles/news-1.jox",
      contentFormat: "html",
      content: '<p>正文</p><figure data-asset-id="lead"></figure>',
      assets: [{
        id: "lead",
        type: "image",
        role: "lead",
        object: "content/newspapers/example/assets/lead.jox",
        mediaType: "image/jpeg",
        size: 3,
        sha256: "abc",
        caption: "图片说明",
      }],
      assetUrls: { lead: "data:image/jpeg;base64,abc" },
    } satisfies MobileTimesNewsItem;
    const document = createTimesArticleDocument(news);
    expect(document).toContain('src="data:image/jpeg;base64,abc"');
    expect(document).toContain("图片说明");
    expect(document).toContain("ReactNativeWebView.postMessage");
    expect(document).toContain("AI 翻译");
    expect(document).toContain("contextmenu");
    expect(document).not.toContain("margin-left:8px");
    const translated = materializeTimesArticleAssets({ ...news,
      content: '<figure data-asset-id="lead"><figcaption>翻译后的图注</figcaption></figure>',
      assets: [{ ...news.assets[0]!, caption: "Original English caption" }],
    });
    expect(translated.match(/<figcaption>/g)).toHaveLength(1);
    expect(translated).toContain("<figcaption>翻译后的图注</figcaption>");
    expect(translated).not.toContain("<figcaption>Original English caption</figcaption>");
    expect(materializeTimesArticleAssets({ ...news, content: translated, assets: [{ ...news.assets[0]!, caption: "Original English caption" }] })).toBe(translated);
  });
});
