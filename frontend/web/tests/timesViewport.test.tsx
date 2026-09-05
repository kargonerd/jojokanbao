import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timesMocks = vi.hoisted(() => ({
  timelineIndex: vi.fn(),
  timelinePage: vi.fn(),
  getNews: vi.fn(),
}));

vi.mock("../src/times/api", () => ({
  timesApi: timesMocks,
  timesTimelinePageCount: (ref: { articleCount: number; pages?: unknown[] }) =>
    ref.pages?.length ?? Math.ceil(ref.articleCount / 50),
}));

import { TimesHomePage } from "../src/times/pages/TimesHomePage";
import { TimesDetailPage } from "../src/times/pages/TimesDetailPage";
import { DEFAULT_SPEECH_PROVIDERS } from "../src/reading/speech";
import { useTimesPreferencesStore } from "../src/times/preferencesStore";
import { useAccountSessionStore } from "../src/account/session";
import { useFeatureFlagStore } from "../src/featureFlags";

const source = { id: "reuters", name: "Reuters", language: "en" };
const article = {
  id: "reuters:viewport-test",
  title: "A viewport regression test article",
  summary: "The list should remain inside its own scroll boundary.",
  contentStatus: "full" as const,
  publishedAt: "2026-09-02T08:00:00.000Z",
  issueDate: "2026-09-02",
  language: "en",
  source,
  url: "https://example.com/viewport-test",
  publisherSections: [],
  articleObject: "content/newspapers/reuters/articles/viewport-test.jox",
  assets: [],
};

beforeEach(() => {
  useFeatureFlagStore.setState((state) => ({ flags: { ...state.flags, "reader.speech": true } }));
  useAccountSessionStore.setState({ initialized: true, userId: "test-reader" });
  window.localStorage.clear();
  useTimesPreferencesStore.setState({
    foreignContentLanguage: "zh-CN",
    disabledSourceIds: [],
  });
  timesMocks.timelineIndex.mockResolvedValue({
    formatVersion: "jojo-news-timeline-index/1",
    updatedAt: "2026-09-02T08:01:00.000Z",
    dates: [{
      date: article.issueDate,
      object: "dates/2026/09/2026-09-02.jox",
      articleCount: 1,
      pages: [{ object: "dates/2026/09/2026-09-02/page-0001.jox", articleCount: 1 }],
    }],
    sources: [source],
  });
  timesMocks.timelinePage.mockResolvedValue({
    formatVersion: "jojo-news-timeline-page/1",
    date: article.issueDate,
    page: 0,
    updatedAt: "2026-09-02T08:01:00.000Z",
    articles: [article],
  });
  timesMocks.getNews.mockResolvedValue({
    ...article,
    content: "Article body",
    contentFormat: "text",
    assetUrls: {},
    originalLanguage: "en",
    translationAvailable: false,
    usingTranslation: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Times viewport containment", () => {
  it("uses the dynamic viewport for the shell while retaining the legacy fallback", async () => {
    const shellCss = await readFile(resolve(process.cwd(), "src/shell/styles.css"), "utf8");
    const shellRule = shellCss.match(/\.app-shell\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";

    expect(shellRule).toMatch(/min-height:\s*100vh;[\s\S]*min-height:\s*100dvh;/u);
  });

  it("contains timeline scrolling instead of chaining it to the document", async () => {
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    const listRegion = screen.getByRole("region", { name: "文章列表" });
    await within(listRegion).findByText(article.title);
    const listViewport = listRegion.querySelector(".overflow-y-auto");

    expect(listViewport).toBeTruthy();
    expect(listViewport?.classList.contains("overscroll-y-contain")).toBe(true);
  });

  it("places the embedded article mini player outside the article scroll area", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      defaultProvider: "edge", requiresAuth: false, providers: DEFAULT_SPEECH_PROVIDERS,
    })));
    const { container } = render(<MemoryRouter>
      <TimesDetailPage issueDate={article.issueDate} newsId={article.id} embedded />
    </MemoryRouter>);
    const launcher = await screen.findByRole("button", { name: "打开听新闻播放器" });
    expect(container.querySelector("[data-times-speech-dock]")?.contains(launcher)).toBe(true);
    await act(async () => { fireEvent.click(launcher); });
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));

    const scrollArea = container.querySelector("[data-times-article-scroll]")!;
    const dock = container.querySelector("[data-times-speech-dock]")!;
    const mini = screen.getByRole("region", { name: "迷你听读播放器" });
    expect(dock.contains(mini)).toBe(true);
    expect(scrollArea.contains(mini)).toBe(false);
    expect(scrollArea.nextElementSibling).toBe(dock);
    expect(dock.classList.contains("shrink-0")).toBe(true);
    expect(dock.classList.contains("relative")).toBe(true);
    expect(dock.parentElement?.classList.contains("min-h-0")).toBe(true);
    expect(document.body.dataset.speechMini).toBe("docked");
    fireEvent.click(screen.getByRole("button", { name: "关闭迷你播放器" }));
    expect(dock.contains(screen.getByRole("button", { name: "打开听新闻播放器" }))).toBe(true);
    expect(screen.queryByRole("region", { name: "迷你听读播放器" })).toBeNull();
  });
});
