import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { usePlatformAccountStore } from "../src/platform/accountSession";
import { useRecentReadingStore } from "../src/platform/recentReadingStore";
import { useFeatureFlagStore } from "../src/featureFlags";

const catalogMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getSources: vi.fn(),
  loadBookCoverUrl: vi.fn(),
}));

const shelfMocks = vi.hoisted(() => ({
  loadBookshelf: vi.fn(),
  setBookshelf: vi.fn(),
}));

vi.mock("../src/rag/api", () => ({
  notebookApi: catalogMocks,
}));

vi.mock("../src/rag/content", () => ({
  loadBookCoverUrl: catalogMocks.loadBookCoverUrl,
}));

vi.mock("../src/rag/readerData", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/rag/readerData")>(),
  loadBookshelf: shelfMocks.loadBookshelf,
  setBookshelf: shelfMocks.setBookshelf,
}));

function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  window.localStorage.clear();
  usePlatformAccountStore.setState({ initialized: true, userId: null, displayName: null });
  useFeatureFlagStore.setState({
    initialized: true,
    revision: "test",
    flags: {
      "library.bookshelf": false,
      "reader.annotations": false,
      "agent.chat": false,
      "rag.workspace": false,
      "olds.workspace": false,
    },
  });
  useRecentReadingStore.setState({ items: [] });
  catalogMocks.list.mockReset();
  catalogMocks.getSources.mockReset();
  catalogMocks.loadBookCoverUrl.mockReset();
  shelfMocks.loadBookshelf.mockReset();
  shelfMocks.setBookshelf.mockReset();
  catalogMocks.loadBookCoverUrl.mockResolvedValue(undefined);
  shelfMocks.loadBookshelf.mockResolvedValue([]);
  shelfMocks.setBookshelf.mockResolvedValue(undefined);
  catalogMocks.list.mockResolvedValue([
    { id: "mao", title: "毛泽东文集", type: "book-series", sources_count: 2 },
    { id: "paper-data", title: "报刊测试集", type: "newspaper", sources_count: 1 },
  ]);
  catalogMocks.getSources.mockResolvedValue([
    { id: "mao-1", itemKey: "volume-1", title: "毛泽东文集 第一卷", published: true },
    { id: "mao-2", itemKey: "volume-2", title: "毛泽东文集 第二卷", published: true },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("platform homepage", () => {
  it("keeps the global navigation focused on the public reading tools", () => {
    renderAt("/");

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(navigation).toBeTruthy();
    expect(screen.getByRole("link", { name: "首页" }).className).toContain("is-active");
    expect(within(navigation).getByRole("link", { name: "资料库" })).toBeTruthy();
    expect(within(navigation).getByRole("link", { name: "搜索" })).toBeTruthy();
    expect(within(navigation).getByRole("link", { name: "关于" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "登录" }).getAttribute("href")).toBe("/account");
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("新闻")).toBeNull();
  });

  it("shows a truthful empty state until something has been opened", () => {
    renderAt("/");

    expect(screen.getByText("还没有阅读记录")).toBeTruthy();
    expect(screen.queryByText("今日一读")).toBeNull();
    expect(screen.getByLabelText("每日语录").className).toContain("daily-quote-footnote");
    expect(screen.getByRole("link", { name: /^去资料库\s*→$/ }).getAttribute("href")).toBe("/library");
  });

  it("fuzzy matches book titles on the homepage and opens the best result", async () => {
    renderAt("/");
    const input = screen.getByRole("searchbox", { name: "搜索书名" });
    await waitFor(() => expect(catalogMocks.list).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "毛文集" } });
    expect(await screen.findByRole("option", { name: /毛泽东文集/ })).toBeTruthy();
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() => expect(window.location.pathname).toBe("/library/mao"));
  });

  it("shows a separate personal bookshelf without the removed shortcut blocks", () => {
    renderAt("/");

    expect(screen.getByRole("heading", { name: "我的书架" })).toBeTruthy();
    expect(screen.getByText("登录后查看你的书架")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^登录\s*→$/ }).getAttribute("href")).toBe("/account?returnTo=/");
    expect(screen.queryByLabelText("资料库快捷入口")).toBeNull();
    expect(screen.queryByText("JOJO READING ROOM")).toBeNull();
  });

  it("keeps search and feedback inside the new platform navigation", () => {
    const searchView = renderAt("/search");
    expect(screen.getByRole("link", { name: "搜索" }).className).toContain("is-active");
    expect(screen.getByPlaceholderText("在JOJO看报上搜索")).toBeTruthy();
    searchView.unmount();
    cleanup();

    renderAt("/support");
    expect(screen.getByRole("link", { name: "关于" }).className).toContain("is-active");
    expect(screen.getByRole("heading", { name: "关于 JOJO 看报" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "数据下载" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开旧版 JOJO 看报" }).getAttribute("href")).toBe("/legacy");
    expect(screen.queryByRole("link", { name: "GitHub 查看源码" })).toBeNull();
  });
});

describe("platform library", () => {
  it("filters to books and opens a collection without exposing an Agent tab", async () => {
    renderAt("/library?type=book");

    const collection = await screen.findByRole("link", { name: /毛泽东文集/ });
    await waitFor(() => expect(catalogMocks.loadBookCoverUrl).toHaveBeenCalledWith("mao", undefined));
    expect(screen.queryByText("人民日报")).toBeNull();
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("新闻")).toBeNull();

    fireEvent.click(collection);
    await waitFor(() => expect(window.location.pathname).toBe("/library/mao"));
    expect((await screen.findAllByText("毛泽东文集 第一卷")).length).toBeGreaterThan(0);
    expect(catalogMocks.getSources).toHaveBeenCalledWith("mao");
  });

  it("sends signed-out readers to login before changing the bookshelf", async () => {
    renderAt("/library?type=book");

    const addButton = await screen.findByRole("button", { name: "登录后加入书架：毛泽东文集" });
    fireEvent.click(addButton);

    await waitFor(() => expect(window.location.pathname).toBe("/account"));
    expect(window.location.search).toBe("?returnTo=%2Flibrary%3Ftype%3Dbook");
    expect(shelfMocks.setBookshelf).not.toHaveBeenCalled();
  });

  it("uses the signed-in reader's server bookshelf", async () => {
    renderAt("/library?type=book");
    act(() => usePlatformAccountStore.setState({ initialized: true, userId: "reader-1", displayName: "测试读者" }));
    act(() => useFeatureFlagStore.setState((state) => ({
      ...state,
      initialized: true,
      flags: { ...state.flags, "library.bookshelf": true },
    })));

    const addButton = await screen.findByRole("button", { name: "加入书架：毛泽东文集" });
    fireEvent.click(addButton);
    await waitFor(() => expect(shelfMocks.setBookshelf).toHaveBeenCalledWith({
      datasetId: "mao",
      itemId: "volume-1",
      title: "毛泽东文集 第一卷",
      added: true,
    }));
    const removeButton = await screen.findByRole("button", { name: "移出书架：毛泽东文集" });
    fireEvent.click(removeButton);
    await waitFor(() => expect(shelfMocks.setBookshelf).toHaveBeenLastCalledWith({
      datasetId: "mao",
      itemId: "volume-1",
      title: "毛泽东文集 第一卷",
      added: false,
    }));
  });

  it("removes the redundant library heading, date and search controls", async () => {
    renderAt("/library");
    await screen.findByRole("link", { name: /人民日报/ });

    expect(screen.queryByText("全部馆藏")).toBeNull();
    expect(screen.queryByText("打开日期")).toBeNull();
    expect(screen.queryByPlaceholderText("搜索资料库")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "搜索馆藏" })).toBeTruthy();
  });

  it("filters periodicals and books from the library search", async () => {
    renderAt("/library");
    await screen.findByRole("link", { name: /人民日报/ });

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索馆藏" }), { target: { value: "毛文集" } });
    expect(screen.getByRole("link", { name: /毛泽东文集/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /人民日报/ })).toBeNull();
  });

  it("records a periodical when it is opened from the library", async () => {
    renderAt("/library?type=periodical");
    const paper = await screen.findByRole("link", { name: /人民日报/ });
    fireEvent.click(paper);

    await waitFor(() => expect(window.location.pathname).toBe("/archive/rmrb/19761009"));
    expect(useRecentReadingStore.getState().items[0]).toMatchObject({
      id: "periodical:rmrb",
      title: "人民日报",
      href: "/archive/rmrb/19761009",
    });
  });
});
