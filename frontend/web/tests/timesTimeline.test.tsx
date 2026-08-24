import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimesHomePage } from "../src/times/pages/TimesHomePage";
import { timesApi } from "../src/times/api";

vi.mock("../src/times/api", () => ({
  timesApi: {
    directory: vi.fn(),
    loadDate: vi.fn(),
  },
}));

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
  vi.mocked(timesApi.directory).mockResolvedValue({
    updatedAt: "2026-08-24T08:10:00Z",
    dates: ["2026-08-24"],
    publishers: [{
      id: "example",
      name: "Example News",
      language: "en",
      indexObject: "content/newspapers/example/index.jox",
      dates: ["2026-08-24"],
    }],
  });
  vi.mocked(timesApi.loadDate).mockResolvedValue({
    date: "2026-08-24",
    articles: [{
      id: "example:lead",
      title: "A real timeline headline",
      summary: "The reader sees the story, not pipeline diagnostics.",
      url: "https://example.test/lead",
      publishedAt: "2026-08-24T08:00:00Z",
      issueDate: "2026-08-24",
      language: "en",
      source: { id: "example", name: "Example News", language: "en" },
      authors: ["Reporter"],
      categories: ["world"],
      publisherCategories: ["World"],
      articleObject: "content/newspapers/example/items/2026/08/2026-08-24/articles/lead.jox",
    }],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Times timeline", () => {
  it("presents chronological news without exposing capture audit controls", async () => {
    render(<MemoryRouter><TimesHomePage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "时事时间线" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "A real timeline headline" })).toBeTruthy();
    await waitFor(() => expect(timesApi.loadDate).toHaveBeenCalledWith("2026-08-24"));
    expect(screen.queryByText("媒体健康度")).toBeNull();
    expect(screen.queryByText("不可用 case")).toBeNull();
    expect(screen.getByRole("link", { name: /A real timeline headline/ }).getAttribute("href"))
      .toBe("/times/example/2026-08-24/example%3Alead");
  });
});
