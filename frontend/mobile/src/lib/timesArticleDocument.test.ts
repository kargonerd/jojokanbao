import type { MobileTimesNewsItem } from "./times";
import { describe, expect, it } from "vitest";
import { createTimesArticleDocument, sanitizeTimesArticleHtml } from "./timesArticleDocument";

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

  it("removes executable publisher markup", () => {
    const safe = sanitizeTimesArticleHtml('<p onclick="steal()">正文</p><script>steal()</script><a href="javascript:steal()">链接</a>');
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
  });
});
