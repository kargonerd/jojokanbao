import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { useAccountSessionStore } from "../src/account/session";
import { useRecentReadingStore } from "../src/library/recentReadingStore";
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

vi.mock("../src/rag/pages/ReaderPage", () => ({
  ReaderPage: () => <h1>书籍阅读器</h1>,
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
  useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null });
  useFeatureFlagStore.setState({
    initialized: true,
    revision: "test",
    flags: {
      "library.bookshelf": false,
      "reader.annotations": false,
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
    { id: "solo", title: "青年政治经济学读本", type: "book", sources_count: 1 },
    { id: "paper-data", title: "报刊测试集", type: "newspaper", sources_count: 1 },
  ]);
  catalogMocks.getSources.mockImplementation(async (datasetId: string) => datasetId === "solo"
    ? [{ id: "solo-full", itemKey: "full-book", title: "青年政治经济学读本", published: true }]
    : [
        { id: "mao-1", itemKey: "volume-1", title: "毛泽东文集 第一卷", published: true },
        { id: "mao-2", itemKey: "volume-2", title: "毛泽东文集 第二卷", published: true },
      ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("app homepage", () => {
  it("keeps the global navigation focused on the public reading tools", () => {
    renderAt("/");

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(navigation).toBeTruthy();
    expect(within(navigation).getByRole("link", { name: "首页" }).className).toContain("is-active");
    expect(within(navigation).queryByRole("link", { name: "书架" })).toBeNull();
    expect(within(navigation).getByRole("link", { name: "资料库" })).toBeTruthy();
    expect(within(navigation).getByRole("link", { name: "搜索" })).toBeTruthy();
    expect(within(navigation).getByRole("link", { name: "关于" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "登录" }).getAttribute("href")).toBe("/account");
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("新闻")).toBeNull();
  });

  it("keeps notifications and account actions inside the reader menu", async () => {
    renderAt("/");
    act(() => useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "长鯙-WUP" }));

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(within(navigation).queryByRole("link", { name: /通知/ })).toBeNull();
    const account = screen.getByRole("button", { name: /长鯙-WUP，账号菜单/ });
    expect(account.querySelector(".app-account-mark")).toBeNull();
    expect(account.querySelector(".app-account-caret")).toBeNull();
    fireEvent.click(account);

    const menu = await screen.findByRole("menu", { name: "读者菜单" });
    expect(within(menu).getByRole("menuitem", { name: /通知/ }).getAttribute("href")).toBe("/notifications");
    expect(within(menu).getByRole("menuitem", { name: /我的书架/ }).getAttribute("href")).toBe("/bookshelf");
    expect(within(menu).getByRole("menuitem", { name: "账号" }).getAttribute("href")).toBe("/account");
    expect(within(menu).getByRole("menuitem", { name: "退出登录" })).toBeTruthy();
    expect(within(menu).queryByText("JOJO 读者账号")).toBeNull();
    expect(within(menu).queryByText("收藏的书")).toBeNull();
    expect(within(menu).queryByText("查看资料")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "读者菜单" })).toBeNull();
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

  it("keeps the homepage focused on continuing to read", () => {
    renderAt("/");

    expect(screen.getByRole("heading", { name: "继续阅读" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "我的书架" })).toBeNull();
    expect(screen.getByRole("link", { name: "我的书架" }).getAttribute("href")).toBe("/bookshelf");
    expect(shelfMocks.loadBookshelf).not.toHaveBeenCalled();
  });

  it("opens the personal bookshelf as a separate page", () => {
    renderAt("/bookshelf");

    expect(screen.getByRole("heading", { name: "书架" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "我的书架" })).toBeNull();
    expect(screen.getByText("登录后查看你的书架")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^登录\s*→$/ }).getAttribute("href")).toBe("/account?returnTo=%2Fbookshelf");
    expect(within(screen.getByRole("navigation", { name: "主导航" })).queryByRole("link", { name: "书架" })).toBeNull();
  });

  it("loads and manages the signed-in reader's bookshelf", async () => {
    shelfMocks.loadBookshelf.mockResolvedValue([
      { datasetId: "mao", itemId: "volume-1", title: "毛泽东文集 第一卷" },
    ]);

    renderAt("/bookshelf");
    act(() => useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "测试读者" }));
    act(() => useFeatureFlagStore.setState((state) => ({
      ...state,
      initialized: true,
      flags: { ...state.flags, "library.bookshelf": true },
    })));

    const book = await screen.findByRole("link", { name: /毛泽东文集 第一卷/ });
    expect(book.getAttribute("href")).toBe("/book/mao/volume-1");
    expect(screen.queryByText("1 项收藏，最近加入的排在前面")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移出书架：毛泽东文集 第一卷" }));
    await waitFor(() => expect(shelfMocks.setBookshelf).toHaveBeenCalledWith({
      datasetId: "mao",
      itemId: "volume-1",
      title: "毛泽东文集 第一卷",
      added: false,
    }));
    expect(await screen.findByText("书架还是空的")).toBeTruthy();
  });

  it("keeps search and feedback inside the new app navigation", () => {
    const searchView = renderAt("/search");
    expect(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("link", { name: "搜索" }).className).toContain("is-active");
    expect(screen.getByPlaceholderText("在JOJO看报上搜索")).toBeTruthy();
    searchView.unmount();
    cleanup();

    renderAt("/support");
    expect(screen.getByRole("link", { name: "关于" }).className).toContain("is-active");
    expect(screen.getByRole("heading", { name: "关于 JOJO 看报" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "数据下载" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "打开旧版 JOJO 看报" })).toBeNull();
    expect(screen.queryByRole("link", { name: "GitHub 查看源码" })).toBeNull();
  });

  it("keeps the app navigation when entering the newspaper archive", () => {
    renderAt("/archive");

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(within(navigation).getByRole("link", { name: "首页" }).getAttribute("href")).toBe("/");
    expect(within(navigation).getByRole("link", { name: "资料库" })).toBeTruthy();
    expect(within(navigation).queryByText("报纸")).toBeNull();
    expect(within(navigation).queryByText("杂志")).toBeNull();
  });

  it("loads the real book cover for an existing recent-reading record", async () => {
    catalogMocks.loadBookCoverUrl.mockResolvedValue("blob:book-cover");
    useRecentReadingStore.setState({
      items: [{
        id: "book:mao:volume-1",
        kind: "book",
        title: "毛泽东文集 第一卷",
        subtitle: "毛泽东文集",
        href: "/book/mao/volume-1",
        progress: 0,
        updatedAt: Date.now(),
      }],
    });

    renderAt("/");

    await waitFor(() => expect(catalogMocks.loadBookCoverUrl).toHaveBeenCalledWith("mao", "volume-1"));
    const card = screen.getByRole("link", { name: /毛泽东文集 第一卷/ });
    await waitFor(() => expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:book-cover"));
  });

  it("shows the last book chapter once and keeps progress exclusive to books", () => {
    useRecentReadingStore.setState({
      items: [
        {
          id: "book:philosophy-new:full-book",
          kind: "book",
          datasetId: "philosophy-new",
          itemKey: "full-book",
          title: "大众哲学",
          subtitle: "第六章 真理是怎样发现的",
          href: "/book/philosophy-new/full-book?chapter=chapter-6",
          progress: 38,
          updatedAt: 3,
        },
        {
          id: "book:philosophy-old:legacy",
          kind: "book",
          datasetId: "philosophy-old",
          itemKey: "legacy",
          title: "大众哲学",
          subtitle: "大众哲学",
          href: "/book/philosophy-old/legacy",
          progress: 0,
          updatedAt: 2,
        },
        {
          id: "periodical:rmrb",
          kind: "periodical",
          publicationId: "rmrb",
          title: "人民日报",
          subtitle: "1989 年 11 月 17 日 · 第 4 页",
          href: "/archive/rmrb/19891117#page-4",
          progress: 0,
          updatedAt: 1,
        },
      ],
    });

    renderAt("/");

    expect(screen.getAllByText("大众哲学")).toHaveLength(1);
    expect(screen.getByText("上次读到 · 第六章 真理是怎样发现的")).toBeTruthy();
    const book = screen.getByRole("link", { name: /大众哲学/ });
    expect(within(book).getByText("38%", { selector: "span" })).toBeTruthy();
    const newspaper = screen.getByRole("link", { name: /人民日报/ });
    expect(within(newspaper).getByText("1989 年 11 月 17 日 · 第 4 页")).toBeTruthy();
    expect(newspaper.querySelector("progress")).toBeNull();
    expect(within(newspaper).queryByText("0%")).toBeNull();
  });
});

describe("app library", () => {
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

  it("distinguishes single books from collections and opens a single book in one click", async () => {
    renderAt("/library?type=book");

    const single = await screen.findByRole("link", { name: /青年政治经济学读本/ });
    const collection = screen.getByRole("link", { name: /毛泽东文集/ });
    expect(within(single).getByText("单册 · 直接阅读")).toBeTruthy();
    expect(within(collection).getByText("2 册 · 选择分册")).toBeTruthy();

    fireEvent.click(single);
    await waitFor(() => expect(window.location.pathname).toBe("/book/solo/full-book"));
    expect(window.location.search).toBe("?returnTo=%2Flibrary%3Ftype%3Dbook");
    expect(await screen.findByRole("heading", { name: "书籍阅读器" })).toBeTruthy();
  });

  it("never leaves a single book on the collection page", async () => {
    renderAt("/library/solo");

    await waitFor(() => expect(window.location.pathname).toBe("/book/solo/full-book"));
    expect(window.location.search).toBe("?returnTo=%2Flibrary%3Ftype%3Dbook");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "青年政治经济学读本" })).toBeNull());
  });

  it("sends signed-out readers to login before changing the bookshelf", async () => {
    renderAt("/library?type=book");

    const addButton = await screen.findByRole("button", { name: "登录后加入书架：青年政治经济学读本" });
    fireEvent.click(addButton);

    await waitFor(() => expect(window.location.pathname).toBe("/account"));
    expect(window.location.search).toBe("?returnTo=%2Flibrary%3Ftype%3Dbook");
    expect(shelfMocks.setBookshelf).not.toHaveBeenCalled();
  });

  it("uses the signed-in reader's server bookshelf", async () => {
    renderAt("/library?type=book");
    act(() => useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "测试读者" }));
    act(() => useFeatureFlagStore.setState((state) => ({
      ...state,
      initialized: true,
      flags: { ...state.flags, "library.bookshelf": true },
    })));

    const addButton = await screen.findByRole("button", { name: "加入书架：青年政治经济学读本" });
    fireEvent.click(addButton);
    await waitFor(() => expect(shelfMocks.setBookshelf).toHaveBeenCalledWith({
      datasetId: "solo",
      itemId: "full-book",
      title: "青年政治经济学读本",
      added: true,
    }));
    const removeButton = await screen.findByRole("button", { name: "移出书架：青年政治经济学读本" });
    fireEvent.click(removeButton);
    await waitFor(() => expect(shelfMocks.setBookshelf).toHaveBeenLastCalledWith({
      datasetId: "solo",
      itemId: "full-book",
      title: "青年政治经济学读本",
      added: false,
    }));
  });

  it("lets readers add individual volumes from a multi-volume collection", async () => {
    renderAt("/library/mao");
    act(() => useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "测试读者" }));
    act(() => useFeatureFlagStore.setState((state) => ({
      ...state,
      initialized: true,
      flags: { ...state.flags, "library.bookshelf": true },
    })));

    const addSecondVolume = await screen.findByRole("button", { name: "加入书架：毛泽东文集 第二卷" });
    fireEvent.click(addSecondVolume);
    await waitFor(() => expect(shelfMocks.setBookshelf).toHaveBeenCalledWith({
      datasetId: "mao",
      itemId: "volume-2",
      title: "毛泽东文集 第二卷",
      added: true,
    }));
    expect(await screen.findByRole("button", { name: "移出书架：毛泽东文集 第二卷" })).toBeTruthy();
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
      publicationId: "rmrb",
      title: "人民日报",
      href: "/archive/rmrb/19761009",
    });
  });

  it("uses the saved publication artwork in recent reading", async () => {
    useRecentReadingStore.setState({
      items: [{
        id: "periodical:rmrb",
        kind: "periodical",
        publicationId: "rmrb",
        title: "人民日报",
        subtitle: "1976 年 10 月 9 日",
        href: "/archive/rmrb/19761009",
        progress: 0,
        updatedAt: Date.now(),
      }],
    });

    renderAt("/");

    const card = screen.getByRole("link", { name: /人民日报/ });
    expect(card.querySelector("img")?.getAttribute("src")).toContain("people-daily-brand");
  });
});
