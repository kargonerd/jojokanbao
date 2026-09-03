import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timesMocks = vi.hoisted(() => ({
  timelineIndex: vi.fn(),
  timelineDay: vi.fn(),
  timelinePage: vi.fn(),
  assetObjectUrl: vi.fn(),
  getNews: vi.fn(),
}));

vi.mock("../src/times/api", () => ({
  timesApi: timesMocks,
  timesTimelinePageCount: (ref: { articleCount: number; pages?: unknown[] }) => ref.pages?.length ?? Math.ceil(ref.articleCount / 50),
}));

import { TimesHomePage } from "../src/times/pages/TimesHomePage";
import { TimesDetailPage } from "../src/times/pages/TimesDetailPage";
import { TimesSourceSettingsPage } from "../src/account/pages/TimesSourceSettingsPage";
import TimesRoutes from "../src/times/TimesRoutes";
import { useTimesPreferencesStore } from "../src/times/preferencesStore";
import { useTimesReadStore } from "../src/times/readStore";

const source = { id: "ap", name: "AP News", language: "en" };
const secondSource = { id: "reuters", name: "Reuters", language: "en" };
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
  useTimesPreferencesStore.setState({ foreignContentLanguage: "zh-CN", disabledSourceIds: [] });
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
  timesMocks.timelinePage.mockResolvedValue({
    formatVersion: "jojo-news-timeline-page/1",
    date: "2026-08-27",
    page: 0,
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
    expect(screen.queryByText("已更新")).toBeNull();
  });

  it("marks publisher updates in the list without replacing the original time", async () => {
    const updatedAt = "2026-08-27T05:28:00.000Z";
    timesMocks.timelinePage.mockResolvedValue({
      formatVersion: "jojo-news-timeline-page/1",
      date: "2026-08-27",
      page: 0,
      updatedAt,
      articles: [{ ...article, updatedAt }],
    });
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    const articleList = screen.getByRole("region", { name: "文章列表" });
    const marker = within(articleList).getByText("已更新");
    expect(marker.getAttribute("title")).toContain("出版方更新于");
    expect(articleList.querySelector(`time[datetime="${article.publishedAt}"]`)).toBeTruthy();
  });

  it("marks AI translations without showing a language setting in Times", async () => {
    timesMocks.timelinePage.mockResolvedValue({
      formatVersion: "jojo-news-timeline-page/1",
      date: "2026-08-27",
      page: 0,
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
    expect(screen.queryByRole("button", { name: /外文内容语言/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "阅读设置" })).toBeNull();
  });

  it("configures media sources separately and always keeps one enabled", async () => {
    timesMocks.timelineIndex.mockResolvedValue({
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [],
      sources: [source, secondSource],
    });
    render(<MemoryRouter><TimesSourceSettingsPage /></MemoryRouter>);

    const apSwitch = await screen.findByRole("switch", { name: "关闭AP News" });
    expect(apSwitch.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "关闭Reuters" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "关闭全部媒体" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(apSwitch);

    expect(screen.getByRole("switch", { name: "开启AP News" }).getAttribute("aria-checked")).toBe("false");
    const lastSource = screen.getByRole<HTMLButtonElement>("switch", { name: "关闭Reuters" });
    expect(lastSource.disabled).toBe(true);
    expect(useTimesPreferencesStore.getState().disabledSourceIds).toEqual(["ap"]);
    expect(JSON.parse(window.localStorage.getItem("jojo-times-preferences") ?? "{}").state.disabledSourceIds).toEqual(["ap"]);

    fireEvent.click(screen.getByRole("switch", { name: "开启全部媒体" }));
    expect(screen.getByRole("switch", { name: "关闭AP News" })).toBeTruthy();
    expect(useTimesPreferencesStore.getState().disabledSourceIds).toEqual([]);

    fireEvent.click(screen.getByRole("switch", { name: "关闭全部媒体" }));
    expect(useTimesPreferencesStore.getState().disabledSourceIds).toEqual(["reuters"]);
    expect(screen.getByRole<HTMLButtonElement>("switch", { name: "关闭AP News" }).disabled).toBe(true);
  });

  it("hides disabled media from the Times rail and timeline", async () => {
    const reutersArticle = { ...article, id: "article-two", title: "Reuters headline", source: secondSource, assets: [] };
    timesMocks.timelineIndex.mockResolvedValue({
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [{ date: "2026-08-27", object: "dates/2026/08/2026-08-27.jox", articleCount: 2 }],
      sources: [source, secondSource],
    });
    timesMocks.timelinePage.mockResolvedValue({
      formatVersion: "jojo-news-timeline-page/1",
      date: "2026-08-27",
      page: 0,
      updatedAt: "2026-08-27T05:00:00.000Z",
      articles: [article, reutersArticle],
    });
    useTimesPreferencesStore.getState().setSourceEnabled("ap", false, ["ap", "reuters"]);

    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText("Reuters headline");
    expect(screen.queryByText(article.title)).toBeNull();
    expect(screen.queryByRole("button", { name: /AP News/ })).toBeNull();
  });

  it("keeps the active article marker and reveals an explicit source overflow hint", async () => {
    render(
      <MemoryRouter initialEntries={[`/times/${article.issueDate}/${article.id}`]}>
        <Routes>
          <Route path="/times/:issueDate/:newsId" element={<TimesHomePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findAllByText(article.title);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "文章列表" }).querySelector("article")).toBeTruthy();
    });
    const articleRow = screen.getByRole("region", { name: "文章列表" }).querySelector("article")!;
    expect(articleRow.className).toContain("border-l-4 border-l-red");
    expect(articleRow.className).toContain("var(--color-red)_5%");
    const sourceRail = screen.getByRole("navigation", { name: "选择媒体" });
    expect(sourceRail.className).toContain("times-source-scroller");

    Object.defineProperties(sourceRail, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollBy: { configurable: true, value: vi.fn() },
    });
    fireEvent(window, new Event("resize"));
    const overflowHint = await screen.findByRole("button", { name: "向下查看更多媒体" });
    fireEvent.click(overflowHint);
    expect(sourceRail.scrollBy).toHaveBeenCalledWith({ top: 160, behavior: "smooth" });

    sourceRail.scrollTop = 300;
    fireEvent.scroll(sourceRail);
    await waitFor(() => expect(screen.queryByRole("button", { name: "向下查看更多媒体" })).toBeNull());
  });

  it("automatically appends one timeline page at a time without paging buttons", async () => {
    const olderArticle = {
      ...article,
      id: "article-older",
      title: "An older headline",
      publishedAt: "2026-08-27T03:58:00.000Z",
      assets: [],
    };
    timesMocks.timelineIndex.mockResolvedValue({
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [{
        date: "2026-08-27",
        object: "dates/2026/08/2026-08-27.jox",
        articleCount: 2,
        pages: [
          { object: "dates/2026/08/2026-08-27/page-0001.jox", articleCount: 1 },
          { object: "dates/2026/08/2026-08-27/page-0002.jox", articleCount: 1 },
        ],
      }],
      sources: [source],
    });
    timesMocks.timelinePage.mockImplementation(async (_date: string, page: number) => ({
      formatVersion: "jojo-news-timeline-page/1",
      date: "2026-08-27",
      page,
      updatedAt: "2026-08-27T05:00:00.000Z",
      articles: page === 0 ? [article] : [olderArticle],
    }));

    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    await screen.findByText(olderArticle.title);
    expect(screen.getAllByText(article.title).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "更早的新闻" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更新的新闻" })).toBeNull();
    expect(timesMocks.timelinePage.mock.calls.filter(([, page]) => page === 1)).toHaveLength(1);
    expect(screen.getByText("已到达时间线起点")).toBeTruthy();
  });

  it("offers new timeline items without replacing the list until the notice is chosen", async () => {
    const refreshedArticle = {
      ...article,
      id: "article-refreshed",
      title: "A newly pulled headline",
      publishedAt: "2026-08-28T01:00:00.000Z",
      issueDate: "2026-08-28",
      assets: [],
    };
    const initialIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [{ date: "2026-08-27", object: "dates/2026/08/2026-08-27.jox", articleCount: 1 }],
      sources: [source],
    };
    const refreshedIndex = {
      ...initialIndex,
      updatedAt: "2026-08-28T01:01:00.000Z",
      dates: [{ date: "2026-08-28", object: "dates/2026/08/2026-08-28.jox", articleCount: 1 }],
    };
    timesMocks.timelineIndex.mockResolvedValueOnce(initialIndex).mockResolvedValueOnce(refreshedIndex);
    timesMocks.timelinePage.mockImplementation(async (date: string, page: number) => ({
      formatVersion: "jojo-news-timeline-page/1",
      date,
      page,
      updatedAt: date === "2026-08-28" ? refreshedIndex.updatedAt : initialIndex.updatedAt,
      articles: date === "2026-08-28" ? [refreshedArticle] : [article],
    }));

    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    const articleList = screen.getByRole("region", { name: "文章列表" });
    expect(screen.queryByRole("button", { name: "拉取最新新闻" })).toBeNull();
    await waitFor(() => {
      fireEvent(window, new Event("focus"));
      expect(timesMocks.timelineIndex.mock.calls.some(([refresh]) => refresh === true)).toBe(true);
    });
    const updateNotice = await screen.findByRole("button", { name: "查看 1 条新的或更新的新闻" });
    expect(within(articleList).getByText(article.title)).toBeTruthy();
    expect(within(articleList).queryByText(refreshedArticle.title)).toBeNull();

    fireEvent.click(updateNotice);
    await within(articleList).findByText(refreshedArticle.title);
    expect(within(articleList).queryByText(article.title)).toBeNull();
    expect(timesMocks.timelineIndex.mock.calls.some(([refresh]) => refresh === true)).toBe(true);
    expect(timesMocks.timelinePage.mock.calls.some(([date, page, refresh]) => (
      date === "2026-08-28" && page === 0 && refresh === true
    ))).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("已载入 1 条新的或更新的新闻");
  });

  it("refreshes the timeline after a touch pull passes the threshold", async () => {
    const refreshedArticle = {
      ...article,
      id: "article-pull-refreshed",
      title: "A headline loaded by pulling",
      publishedAt: "2026-08-28T01:00:00.000Z",
      issueDate: "2026-08-28",
      assets: [],
    };
    const initialIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [{ date: "2026-08-27", object: "dates/2026/08/2026-08-27.jox", articleCount: 1 }],
      sources: [source],
    };
    const refreshedIndex = {
      ...initialIndex,
      updatedAt: "2026-08-28T01:01:00.000Z",
      dates: [{ date: "2026-08-28", object: "dates/2026/08/2026-08-28.jox", articleCount: 1 }],
    };
    timesMocks.timelineIndex.mockResolvedValueOnce(initialIndex).mockResolvedValueOnce(refreshedIndex);
    timesMocks.timelinePage.mockImplementation(async (date: string, page: number) => ({
      formatVersion: "jojo-news-timeline-page/1",
      date,
      page,
      updatedAt: date === "2026-08-28" ? refreshedIndex.updatedAt : initialIndex.updatedAt,
      articles: date === "2026-08-28" ? [refreshedArticle] : [article],
    }));

    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    const listViewport = screen.getByRole("region", { name: "文章列表" }).querySelector(".overflow-y-auto")!;
    fireEvent.touchStart(listViewport, { touches: [{ clientY: 20 }] });
    fireEvent.touchMove(listViewport, { touches: [{ clientY: 80 }] });
    fireEvent.touchEnd(listViewport);
    expect(timesMocks.timelineIndex).toHaveBeenCalledTimes(1);

    fireEvent.touchStart(listViewport, { touches: [{ clientY: 20 }] });
    fireEvent.touchMove(listViewport, { touches: [{ clientY: 180 }] });
    fireEvent.touchEnd(listViewport);

    await screen.findByText(refreshedArticle.title);
    expect(timesMocks.timelineIndex.mock.calls.some(([refresh]) => refresh === true)).toBe(true);
    expect(timesMocks.timelinePage.mock.calls.some(([date, page, refresh]) => (
      date === "2026-08-28" && page === 0 && refresh === true
    ))).toBe(true);
    expect(screen.getByText("已载入 1 条新的或更新的新闻")).toBeTruthy();
  });

  it("counts a publisher revision of an existing article as an update", async () => {
    const initialIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [{ date: article.issueDate, object: "dates/2026/08/2026-08-27.jox", articleCount: 1 }],
      sources: [source],
    };
    const refreshedIndex = { ...initialIndex, updatedAt: "2026-08-27T05:30:00.000Z" };
    const revisedArticle = {
      ...article,
      title: "Headline revised by the publisher",
      updatedAt: "2026-08-27T05:29:00.000Z",
    };
    timesMocks.timelineIndex.mockResolvedValueOnce(initialIndex).mockResolvedValueOnce(refreshedIndex);
    timesMocks.timelinePage
      .mockResolvedValueOnce({
        formatVersion: "jojo-news-timeline-page/1",
        date: article.issueDate,
        page: 0,
        updatedAt: initialIndex.updatedAt,
        articles: [article],
      })
      .mockResolvedValueOnce({
        formatVersion: "jojo-news-timeline-page/1",
        date: article.issueDate,
        page: 0,
        updatedAt: refreshedIndex.updatedAt,
        articles: [revisedArticle],
      });

    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    await waitFor(() => {
      fireEvent(window, new Event("focus"));
      expect(timesMocks.timelineIndex.mock.calls.some(([refresh]) => refresh === true)).toBe(true);
    });
    expect(await screen.findByRole("button", { name: "查看 1 条新的或更新的新闻" })).toBeTruthy();
  });

  it("does not append a stale automatic page after pulling a fresh timeline", async () => {
    const staleOlderArticle = {
      ...article,
      id: "article-stale-older",
      title: "A stale older headline",
      assets: [],
    };
    const refreshedArticle = {
      ...article,
      id: "article-race-refreshed",
      title: "The refreshed timeline headline",
      issueDate: "2026-08-28",
      publishedAt: "2026-08-28T01:00:00.000Z",
      assets: [],
    };
    const initialIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-27T05:00:00.000Z",
      dates: [{
        date: "2026-08-27",
        object: "dates/2026/08/2026-08-27.jox",
        articleCount: 2,
        pages: [
          { object: "dates/2026/08/2026-08-27/page-0001.jox", articleCount: 1 },
          { object: "dates/2026/08/2026-08-27/page-0002.jox", articleCount: 1 },
        ],
      }],
      sources: [source],
    };
    const refreshedIndex = {
      ...initialIndex,
      updatedAt: "2026-08-28T01:01:00.000Z",
      dates: [{ date: "2026-08-28", object: "dates/2026/08/2026-08-28.jox", articleCount: 1 }],
    };
    let resolveOlder!: (value: unknown) => void;
    const olderPage = new Promise((resolve) => { resolveOlder = resolve; });
    timesMocks.timelineIndex.mockResolvedValueOnce(initialIndex).mockResolvedValueOnce(refreshedIndex);
    timesMocks.timelinePage.mockImplementation(async (date: string, page: number) => {
      if (date === "2026-08-28") {
        return {
          formatVersion: "jojo-news-timeline-page/1",
          date,
          page,
          updatedAt: refreshedIndex.updatedAt,
          articles: [refreshedArticle],
        };
      }
      if (page === 1) return olderPage;
      return {
        formatVersion: "jojo-news-timeline-page/1",
        date,
        page,
        updatedAt: initialIndex.updatedAt,
        articles: [article],
      };
    });

    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    await screen.findByText(article.title);
    await waitFor(
      () => expect(timesMocks.timelinePage.mock.calls.some(([, page]) => page === 1)).toBe(true),
      { timeout: 5_000 },
    );
    await waitFor(() => {
      fireEvent(window, new Event("focus"));
      expect(timesMocks.timelineIndex.mock.calls.some(([refresh]) => refresh === true)).toBe(true);
    });
    fireEvent.click(await screen.findByRole("button", { name: "查看 1 条新的或更新的新闻" }));
    await screen.findByText(refreshedArticle.title);

    resolveOlder({
      formatVersion: "jojo-news-timeline-page/1",
      date: "2026-08-27",
      page: 1,
      updatedAt: initialIndex.updatedAt,
      articles: [staleOlderArticle],
    });
    await olderPage;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByText(staleOlderArticle.title)).toBeNull();
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
    expect(useTimesPreferencesStore.getState().foreignContentLanguage).toBe("zh-CN");
    expect(JSON.parse(window.localStorage.getItem("jojo-times-preferences") ?? "{}").state?.foreignContentLanguage)
      .toBe("zh-CN");
  });

  it("shows publisher publication and update times on the detail page", async () => {
    const updatedAt = "2026-08-27T05:28:00.000Z";
    timesMocks.getNews.mockResolvedValue({
      ...article,
      updatedAt,
      content: "Updated publisher body",
      contentFormat: "text",
      assetUrls: {},
      originalLanguage: "en",
      translations: {
        "zh-CN": {
          language: "zh-CN",
          title: "更新前的中文标题",
          articleObject: "content/newspapers/example/articles/article-one-zh.jox",
          provider: "google-gemini-api",
          model: "gemma-4-31b-it",
          stale: true,
        },
      },
      translationAvailable: true,
      usingTranslation: true,
    });
    render(<MemoryRouter><TimesDetailPage issueDate={article.issueDate} newsId={article.id} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: article.title })).toBeTruthy();
    const publishedTime = document.querySelector(`time[datetime="${article.publishedAt}"]`);
    const updatedTime = document.querySelector(`time[datetime="${updatedAt}"]`);
    expect(publishedTime?.parentElement?.textContent).toContain("发布于");
    expect(updatedTime?.parentElement?.textContent).toContain("更新于");
    expect(screen.getByRole("status").textContent).toContain("原文已更新，中文译文正在同步");
  });

  it("spreads legacy trailing images through the article body", async () => {
    timesMocks.getNews.mockResolvedValue({
      ...article,
      content: [
        "<p>第一段正文</p>",
        "<p>第二段正文</p>",
        "<p>第三段正文</p>",
        "<p>第四段正文</p>",
        '<figure data-asset-id="asset:first"></figure>',
        '<figure data-asset-id="asset:second"></figure>',
      ].join(""),
      contentFormat: "html",
      assets: [
        { ...article.assets[0], id: "asset:first" },
        { ...article.assets[0], id: "asset:second" },
      ],
      assetUrls: { "asset:first": "blob:first", "asset:second": "blob:second" },
      originalLanguage: "en",
      translationAvailable: false,
      usingTranslation: false,
    });

    render(<MemoryRouter><TimesDetailPage issueDate={article.issueDate} newsId={article.id} /></MemoryRouter>);

    expect(await screen.findAllByRole("img", { name: "Photograph from the publisher" })).toHaveLength(2);
    const articleBody = document.querySelector(".prose-editorial");
    expect([...articleBody!.children].map((element) => element.tagName)).toEqual([
      "P", "FIGURE", "P", "P", "FIGURE", "P",
    ]);
  });

  it("renders a carousel group with controls, keyboard navigation and swipe", async () => {
    const galleryAssets = [0, 1, 2].map((order) => ({
      ...article.assets[0],
      id: `asset:gallery-${order + 1}`,
      alt: `Gallery photo ${order + 1}`,
      caption: `Publisher caption ${order + 1}`,
      presentation: { type: "carousel" as const, id: "primary-gallery", order, total: 3 },
    }));
    timesMocks.getNews.mockResolvedValue({
      ...article,
      content: galleryAssets.map((asset, index) => `<figure data-asset-id="${asset.id}"><figcaption>中文图注 ${index + 1}</figcaption></figure>`).join("") + "<p>翻译后的正文。</p>",
      contentFormat: "html",
      assets: galleryAssets,
      assetUrls: Object.fromEntries(galleryAssets.map((asset, index) => [asset.id, `blob:gallery-${index + 1}`])),
      originalLanguage: "en",
      translationAvailable: true,
      usingTranslation: true,
    });

    render(<MemoryRouter><TimesDetailPage issueDate={article.issueDate} newsId={article.id} /></MemoryRouter>);

    const carousel = await screen.findByLabelText("图片轮播，共 3 张");
    expect(screen.getByRole("img", { name: "Gallery photo 1" }).getAttribute("src")).toBe("blob:gallery-1");
    expect(screen.getByText("中文图注 1")).toBeTruthy();
    expect(screen.queryByText("Publisher caption 1")).toBeNull();
    expect(document.querySelectorAll(".times-article-body > figure")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(screen.getByRole("img", { name: "Gallery photo 2" })).toBeTruthy();
    expect(screen.getByText("中文图注 2")).toBeTruthy();
    expect(screen.queryByText("Publisher caption 2")).toBeNull();

    fireEvent.keyDown(carousel, { key: "ArrowLeft" });
    expect(screen.getByRole("img", { name: "Gallery photo 1" })).toBeTruthy();

    fireEvent.touchStart(carousel, { touches: [{ clientX: 120 }] });
    fireEvent.touchEnd(carousel, { changedTouches: [{ clientX: 40 }] });
    expect(screen.getByRole("img", { name: "Gallery photo 2" })).toBeTruthy();
  });

  it("keeps publisher links obvious without doubling Chinese paragraph indentation", async () => {
    timesMocks.getNews.mockResolvedValue({
      ...article,
      content: '<p>　　<a href="https://example.com/source">中新网</a>正文内容</p><hr><p>分隔后的正文内容</p>',
      contentFormat: "html",
      assets: [],
      assetUrls: {},
      originalLanguage: "zh-CN",
      translationAvailable: false,
      usingTranslation: false,
    });

    render(<MemoryRouter><TimesDetailPage issueDate={article.issueDate} newsId={article.id} /></MemoryRouter>);

    const link = await screen.findByRole("link", { name: "中新网" });
    expect(link.parentElement?.textContent).toBe("中新网正文内容");
    expect(document.querySelector(".times-article-body")?.className).toContain("[&_a]:!text-red");
    expect(document.querySelector(".times-article-body")?.className).toContain("[&_hr]:bg-rule");
    expect(document.querySelector(".times-article-body hr")).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://example.com/source");
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
