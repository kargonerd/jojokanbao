import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timesMocks = vi.hoisted(() => ({
  timelineIndex: vi.fn(),
  timelineDay: vi.fn(),
  assetObjectUrl: vi.fn(),
}));

vi.mock("../src/times/api", () => ({ timesApi: timesMocks }));

import { TimesHomePage } from "../src/times/pages/TimesHomePage";

const source = { id: "example", name: "Example News", language: "en" };
const article = {
  id: "article-one",
  title: "Headline with an archived photograph",
  summary: "Summary",
  contentStatus: "full" as const,
  publishedAt: "2026-08-27T04:58:00.000Z",
  issueDate: "2026-08-27",
  language: "en",
  source,
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
  it("shows the archived lead image instead of a text badge", async () => {
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    const image = await screen.findByRole("img", { name: "Photograph from the publisher" });
    expect(image.getAttribute("src")).toBe("blob:timeline-lead");
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
});
