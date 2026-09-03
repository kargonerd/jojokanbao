import type { TimesDeliveryArticle, TimesTimelineIndex } from "@jojo/content";
import { describe, expect, it } from "vitest";
import {
  firstTimesTimelineCursor,
  nextTimesTimelineCursor,
  presentMobileTimesArticle,
  relativeTimesArticleTime,
  safeTimesExternalUrl,
} from "./times";

const article = {
  id: "news-1",
  title: "Original title",
  summary: "Original summary",
  contentStatus: "full",
  publishedAt: "2026-09-03T00:00:00.000Z",
  issueDate: "20260903",
  language: "en",
  source: { id: "example", name: "Example", language: "en" },
  articleObject: "content/newspapers/example/articles/news-1.jox",
  assets: [],
  translations: {
    "zh-CN": {
      language: "zh-CN",
      title: "中文标题",
      summary: "中文摘要",
      articleObject: "content/newspapers/example/articles/news-1.zh-CN.jox",
      provider: "google-gemini-api",
      model: "test",
    },
  },
} satisfies TimesDeliveryArticle;

describe("mobile times data", () => {
  it("presents a Chinese translation without losing original metadata", () => {
    expect(presentMobileTimesArticle(article, "zh-CN")).toMatchObject({
      title: "中文标题",
      summary: "中文摘要",
      usingTranslation: true,
      translationAvailable: true,
      originalLanguage: "en",
    });
    expect(presentMobileTimesArticle(article, "original").title).toBe("Original title");
  });

  it("walks paginated days in timeline order", () => {
    const index = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-09-03T00:00:00.000Z",
      sources: [],
      dates: [
        { date: "20260903", object: "day-1.jox", articleCount: 2, pages: [{ object: "p0.jox", articleCount: 1 }, { object: "p1.jox", articleCount: 1 }] },
        { date: "20260902", object: "day-2.jox", articleCount: 1, pages: [{ object: "p0.jox", articleCount: 1 }] },
      ],
    } satisfies TimesTimelineIndex;
    expect(firstTimesTimelineCursor(index)).toEqual({ dateIndex: 0, page: 0 });
    expect(nextTimesTimelineCursor(index, { dateIndex: 0, page: 0 })).toEqual({ dateIndex: 0, page: 1 });
    expect(nextTimesTimelineCursor(index, { dateIndex: 0, page: 1 })).toEqual({ dateIndex: 1, page: 0 });
    expect(nextTimesTimelineCursor(index, { dateIndex: 1, page: 0 })).toBeNull();
  });

  it("formats relative time and rejects unsafe external links", () => {
    const now = new Date("2026-09-03T01:00:00.000Z").valueOf();
    expect(relativeTimesArticleTime("2026-09-03T00:30:00.000Z", now)).toBe("30分钟前");
    expect(safeTimesExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeTimesExternalUrl("https://example.com/story")).toBe("https://example.com/story");
  });
});
