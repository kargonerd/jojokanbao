import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timesMocks = vi.hoisted(() => ({
  timelineIndex: vi.fn(),
  timelineDay: vi.fn(),
  assetObjectUrl: vi.fn(),
  getNews: vi.fn(),
}));

vi.mock("../src/times/api", () => ({ timesApi: timesMocks }));

import { TimesHomePage } from "../src/times/pages/TimesHomePage";
import { TimesDetailPage } from "../src/times/pages/TimesDetailPage";
import TimesRoutes from "../src/times/TimesRoutes";
import { useTimesPreferencesStore } from "../src/times/preferencesStore";
import { useTimesReadStore } from "../src/times/readStore";

const source = { id: "ap", name: "AP News", language: "en" };
const article = {
  id: "article-one",
  title: "Headline with an archived photograph",
  summary: "Summary",
  contentStatus: "full" as const,
  publishedAt: "2026-08-27T04:58:00.000Z",
  issueDate: "2026-08-27",
  language: "en",
  source,
  url: "https://example.com/article-one",
  publisherSections: [{ id: "world", name: "World News" }],
  articleObject: "content/newspapers/example/articles/article-one.jox",
  assets: [{
    id: "asset:lead",
    type: "image" as const,
    role: "lead",
    mediaType: "image/jpeg",
    object: "content/newspapers/example/assets/lead.jox",
    size: 100,
    sha256: "lead",
    alt: "Photograph from the publisher",
  }],
};

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this);
  }

  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}

beforeEach(() => {
  window.localStorage.clear();
  useTimesReadStore.setState({ readById: {} });
  useTimesPreferencesStore.setState({ foreignContentLanguage: "zh-CN" });
  timesMocks.timelineIndex.mockResolvedValue({
    formatVersion: "jojo-news-timeline-index/1",
    updatedAt: "2026-08-27T05:00:00.000Z",
    dates: [{ date: "2026-08-27", object: "dates/2026/08/2026-08-27.jox", articleCount: 1 }],
    sources: [source],
  });
  timesMocks.timelineDay.mockResolvedValue({
    formatVersion: "jojo-news-timeline-day/1",
    date: "2026-08-27",
    updatedAt: "2026-08-27T05:00:00.000Z",
    articles: [article],
  });
  timesMocks.assetObjectUrl.mockResolvedValue("blob:timeline-lead");
  timesMocks.getNews.mockResolvedValue({
    ...article,
    content: "Archived article body",
    contentFormat: "text",
    assetUrls: {},
    originalLanguage: "en",
    translationAvailable: false,
    usingTranslation: false,
  });
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  const NativeUrl = URL;
  class TestUrl extends NativeUrl {
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", TestUrl);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Times timeline images", () => {
  it("moves source selection into the dedicated media rail", async () => {
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    expect(screen.queryByText("Global wire · ten-minute edition")).toBeNull();
    expect(screen.queryByLabelText("阅读状态筛选")).toBeNull();
    const mediaFilter = screen.getByRole("button", { name: "筛选媒体，当前：所有媒体" });
    expect(mediaFilter.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("button", { name: /所有媒体/ })).toHaveLength(2);
    const sourceButton = screen.getAllByRole("button", { name: new RegExp(source.name) })[0]!;
    expect(sourceButton).toBeTruthy();
    expect(within(sourceButton).queryByText("1")).toBeNull();
    expect(sourceButton.querySelector(`[data-source-logo="${source.id}"]`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "时事" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(source.name) }));
    await waitFor(() => expect(screen.getByRole("heading", { name: source.name })).toBeTruthy());
    expect(screen.getByRole("button", { name: `筛选媒体，当前：${source.name}` })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `筛选媒体，当前：${source.name}` }));
    const sourceDialog = screen.getByRole("dialog", { name: "筛选媒体" });
    expect(within(sourceDialog).getByText(`当前：${source.name}`)).toBeTruthy();
    fireEvent.click(within(sourceDialog).getByRole("button", { name: "所有媒体" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "时事" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "筛选媒体，当前：所有媒体" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "筛选媒体" })).getByRole("button", { name: source.name }));
    await waitFor(() => expect(screen.getByRole("heading", { name: source.name })).toBeTruthy());
  });

  it("shows relative list times with the exact timestamp on hover", async () => {
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    const time = document.querySelector(`time[datetime="${article.publishedAt}"]`);
    expect(time?.textContent).toMatch(/^(刚刚|\d+(分钟前|小时前|天前|周前|个月前|年前))$/);
    expect(time?.getAttribute("title")).toContain("2026");
    expect(screen.queryByText("World News")).toBeNull();
    const sourceLabel = screen.getByRole("region", { name: "文章列表" }).querySelector("article a:not([aria-label]) > span > span");
    expect(sourceLabel?.className).toContain("flex-1");
  });

  it("marks AI translations and persists the publisher-language preference", async () => {
    timesMocks.timelineDay.mockResolvedValue({
      formatVersion: "jojo-news-timeline-day/1",
      date: "2026-08-27",
      updatedAt: "2026-08-27T05:00:00.000Z",
      articles: [{
        ...article,
        translations: {
          "zh-CN": {
            language: "zh-CN",
            title: "中文新闻标题",
            summary: "中文新闻摘要",
            articleObject: "content/newspapers/example/articles/article-one-zh.jox",
            provider: "google-gemini-api",
            model: "gemma-4-31b-it",
          },
        },
      }],
    });
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText("中文新闻标题");
    expect(screen.getByText("AI 翻译")).toBeTruthy();
    const languageButton = screen.getByRole("button", { name: "外文内容语言：中文译文" });
    fireEvent.click(languageButton);
    const dialog = screen.getByRole("dialog", { name: "阅读设置" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "原文" }));

    await screen.findByText(article.title);
    expect(screen.queryByText("中文新闻标题")).toBeNull();
    expect(screen.queryByText("AI 翻译")).toBeNull();
    expect(useTimesPreferencesStore.getState().foreignContentLanguage).toBe("original");
    expect(JSON.parse(window.localStorage.getItem("jojo-times-preferences") ?? "{}").state.foreignContentLanguage).toBe("original");
  });

  it("switches the article body between AI translation and publisher original", async () => {
    timesMocks.getNews.mockImplementation(async (_issueDate: string, _newsId: string, language: string) => ({
      ...article,
      title: language === "original" ? article.title : "中文新闻标题",
      summary: language === "original" ? article.summary : "中文新闻摘要",
      language: language === "original" ? "en" : "zh-CN",
      content: language === "original" ? "Publisher body" : "中文正文",
      contentFormat: "text",
      assetUrls: {},
      originalLanguage: "en",
      translationAvailable: true,
      usingTranslation: language !== "original",
    }));
    render(
      <MemoryRouter>
        <TimesDetailPage issueDate={article.issueDate} newsId={article.id} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "中文新闻标题" })).toBeTruthy();
    expect(screen.getByText("AI 翻译")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));

    expect(await screen.findByRole("heading", { name: article.title })).toBeTruthy();
    expect(screen.getByText("Publisher body")).toBeTruthy();
    expect(screen.queryByText("AI 翻译")).toBeNull();
    expect(screen.getByRole("button", { name: "查看中文译文" })).toBeTruthy();
    expect(timesMocks.getNews).toHaveBeenLastCalledWith(article.issueDate, article.id, "original");
  });

  it("shows the archived lead image instead of a text badge", async () => {
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    const image = await screen.findByRole("img", { name: "Photograph from the publisher" });
    const articleList = screen.getByRole("region", { name: "文章列表" });
    const title = within(articleList).getByText(article.title);
    const summary = within(articleList).getByText(article.summary);
    expect(image.getAttribute("src")).toBe("blob:timeline-lead");
    expect(image.closest("a")?.className).not.toContain("border-l-2");
    expect(title.style.webkitLineClamp).toBe("2");
    expect(summary.style.webkitLineClamp).toBe("3");
    await screen.findByText("Archived article body");
    expect(screen.getAllByText(article.summary)).toHaveLength(1);
    expect(screen.queryByText("图文存档")).toBeNull();
    expect(timesMocks.assetObjectUrl).toHaveBeenCalledWith(article.assets[0], expect.any(AbortSignal));
  });

  it("falls back to the text layout when the archived image cannot be read", async () => {
    timesMocks.assetObjectUrl.mockRejectedValueOnce(new Error("image unavailable"));
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    await waitFor(() => expect(screen.queryByRole("link", { name: `打开：${article.title}` })).toBeNull());
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("subtly styles an article as viewed after it is explicitly opened", async () => {
    render(<MemoryRouter initialEntries={["/times"]}><Routes><Route path="/times/*" element={<TimesRoutes />} /></Routes></MemoryRouter>);

    await screen.findByText(article.title);
    const articleList = screen.getByRole("region", { name: "文章列表" });
    const title = within(articleList).getByText(article.title);
    const articleRow = title.closest("article");
    expect(articleRow?.getAttribute("data-read")).toBe("false");
    expect(title.className).toContain("font-black");
    expect(screen.queryByText(/未读/u)).toBeNull();

    fireEvent.click(within(articleList).getAllByRole("link", { name: new RegExp(article.title) })[0]!);
    await waitFor(() => expect(useTimesReadStore.getState().readById[article.id]).toBe(true));
    expect(document.querySelector("main")?.className).toContain("min-h-[calc(100dvh-58px)] overflow-visible");
    expect(document.querySelector("main")?.className).toContain("lg:overflow-hidden");
    expect(articleRow?.getAttribute("data-read")).toBe("true");
    expect(title.className).toContain("font-medium");
    expect(title.className).toContain("text-muted");
    expect(title.closest("a")?.className).toContain("opacity-60");
    expect(screen.queryByRole("button", { name: /标为/u })).toBeNull();
  });
});
