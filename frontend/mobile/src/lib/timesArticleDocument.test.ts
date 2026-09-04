import type { MobileTimesNewsItem } from "./times";
import { describe, expect, it } from "vitest";
import { createTimesArticleDocument, sanitizeTimesArticleHtml } from "./timesArticleDocument";

describe("mobile times article document", () => {
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
