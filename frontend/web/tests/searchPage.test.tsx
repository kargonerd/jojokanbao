import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_SEARCH_API } from "@jojo/content";
import { SearchPage } from "../src/archive/pages/SearchPage";

vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

interface ResultFixture {
  title: string;
  content: string;
  date: string;
  page: number;
}

const defaultResult: ResultFixture = {
  title: "革命@highlight@历史@/highlight@文献",
  content: "第一段\n@highlight@重点内容@/highlight@",
  date: "1966-07-01",
  page: 5,
};
const highlightedTitleName = /革命\s*历史\s*文献/;

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}{location.search}</output>
      <button type="button" data-testid="navigate-second-search" onClick={() => navigate("/search?keyword=第二&sort=timeDesc")}>切换测试地址</button>
      <button type="button" data-testid="navigate-back" onClick={() => navigate(-1)}>返回测试地址</button>
    </>
  );
}

function renderSearch(path = "/search", platformRedesign = false) {
  window.history.replaceState({}, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/search" element={<SearchPage platformRedesign={platformRedesign} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function searchResponse(results: ResultFixture[] = [defaultResult], total = results.length) {
  return Promise.resolve({ data: { data: { results, total } } });
}

function getLastRequestParams(): Record<string, unknown> {
  const calls = vi.mocked(axios.get).mock.calls;
  const call = calls.at(-1);
  if (!call) throw new Error("Search API was not called");
  return (call[1] as { params: Record<string, unknown> }).params;
}

beforeEach(() => {
  vi.mocked(axios.get).mockReset();
  vi.mocked(axios.post).mockReset();
  vi.mocked(axios.get).mockImplementation(() => searchResponse());
  vi.mocked(axios.post).mockImplementation(() => searchResponse());
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SearchPage initial search", () => {
  it("uses the app canvas only in the redesigned shell", () => {
    const { unmount } = renderSearch("/search", true);
    const redesignedContainer = document.querySelector("[data-search-scroll-container]");
    expect(redesignedContainer?.classList.contains("app-search-page")).toBe(true);
    expect(redesignedContainer?.classList.contains("bg-paper")).toBe(false);

    unmount();
    renderSearch();
    expect(document.querySelector("[data-search-scroll-container]")?.classList.contains("bg-paper")).toBe(true);
  });

  it("focuses the empty search box and ignores blank submissions", () => {
    renderSearch();
    const input = screen.getByPlaceholderText("在JOJO看报上搜索") as HTMLInputElement;

    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(axios.get).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe("/search");
  });

  it("submits on Enter, trims the page state, and syncs the keyword to the URL", async () => {
    renderSearch();
    const input = screen.getByPlaceholderText("在JOJO看报上搜索");
    fireEvent.change(input, { target: { value: "历史" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("heading", { name: highlightedTitleName })).toBeTruthy());
    expect(getLastRequestParams()).toEqual({ keyword: "历史", page: 1, size: 10 });
    expect(screen.getByTestId("location").textContent).toBe("/search?keyword=%E5%8E%86%E5%8F%B2");
  });

  it("restores all filters from the URL and requests the matching page", async () => {
    renderSearch("/search?keyword=梁祝&page=2&sort=timeDesc&startDate=19600701&endDate=19940701");

    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
    expect(getLastRequestParams()).toEqual({
      keyword: "梁祝",
      page: 2,
      size: 10,
      sort: "timeDesc",
      startDate: "1960-07-01",
      endDate: "1994-07-01",
    });
    expect(screen.getByRole("button", { name: "时间降序" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "日期范围：1960-07-01 — 1994-07-01" })).toBeTruthy();
  });
});

describe("SearchPage results", () => {
  it("uses the unified content index only in the redesigned frontend", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { data: {
      total: 21,
      results: [{
        type: "newspaper",
        datasetId: "rmrb",
        itemId: "rmrb:1966-07-01",
        title: "革命历史文献",
        content: "完整正文",
        date: "1966-07-01",
        metadata: { page: 5, ordinal: 2 },
        titleHighlights: ["革命<mark>历史</mark>文献"],
        highlights: ["第一段\n<mark>重点内容</mark>"],
      }],
    } } });

    renderSearch("/search?keyword=历史&page=2&sort=timeDesc&startDate=19660701&endDate=19660731", true);

    const heading = await screen.findByRole("heading", { name: highlightedTitleName });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledWith(CONTENT_SEARCH_API, {
      query: "历史",
      page: 2,
      size: 10,
      datasetIds: ["rmrb"],
      types: ["newspaper"],
      sort: "timeDesc",
      startDate: "1966-07-01",
      endDate: "1966-07-31",
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(heading.querySelector("strong")?.textContent).toBe("历史");
    expect(heading.closest("a")?.getAttribute("href")).toBe("/archive/rmrb/19660701#page-5");
    expect(screen.getByText("重点内容").className).toContain("search-highlight");
    expect(screen.getByText("11")).toBeTruthy();
  });

  it("keeps the legacy frontend on the existing GET search API", async () => {
    renderSearch("/search?keyword=历史", false);
    await screen.findByRole("heading", { name: highlightedTitleName });

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("renders safe result structure, highlights, line breaks, metadata, and links", async () => {
    renderSearch("/search?keyword=历史");
    const heading = await screen.findByRole("heading", { name: highlightedTitleName });
    const resultLink = heading.closest("a")!;
    const content = screen.getByText("重点内容").parentElement!;

    expect(heading.querySelector("strong")?.textContent).toBe("历史");
    expect(heading.querySelector("strong")?.className).toContain("search-highlight");
    expect(resultLink.getAttribute("href")).toBe("/archive/rmrb/19660701#page-5");
    expect(resultLink.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("人民日报")).toBeTruthy();
    expect(screen.getByText("1966-07-01")).toBeTruthy();
    expect(screen.getByText("第5版")).toBeTruthy();
    expect(content.querySelector("br")).toBeTruthy();
    expect(content.querySelector("span.search-highlight")?.textContent).toBe("重点内容");
  });

  it("renders API HTML as inert text while preserving highlight markers", async () => {
    vi.mocked(axios.get).mockImplementation(() => searchResponse([{
      ...defaultResult,
      title: "标题<img src=x onerror=alert(1)>@highlight@历史@/highlight@",
      content: "<script>window.__searchXss = true</script>正文",
    }]));
    renderSearch("/search?keyword=历史");

    const highlight = await screen.findByText("历史", { selector: "strong" });
    const heading = highlight.closest("h3")!;
    expect(highlight.className).toContain("search-highlight");
    expect(heading.textContent).toBe("标题<img src=x onerror=alert(1)>历史");
    expect(heading.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(heading.querySelector("strong")?.textContent).toBe("历史");
    expect(screen.getByText(/<script>window.__searchXss = true<\/script>正文/)).toBeTruthy();
  });

  it("expands a clamped result and removes the one-shot expand control", async () => {
    renderSearch("/search?keyword=历史");
    await screen.findByRole("heading", { name: highlightedTitleName });
    const expand = screen.getByRole("button", { name: "显示全部" });
    const content = screen.getByText("重点内容").parentElement!;
    expect(content.className).toContain("line-clamp-3");

    fireEvent.click(expand);
    expect(content.className).not.toContain("line-clamp-3");
    expect(screen.queryByRole("button", { name: "显示全部" })).toBeNull();
  });

  it("shows an explicit empty result state", async () => {
    vi.mocked(axios.get).mockImplementation(() => searchResponse([], 0));
    renderSearch("/search?keyword=不存在");

    expect(await screen.findByText("没有找到相关结果")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("recovers when a failed request is retried", async () => {
    vi.mocked(axios.get)
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => searchResponse());
    renderSearch("/search?keyword=历史");

    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: highlightedTitleName })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("搜索失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: highlightedTitleName })).toBeTruthy();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("ignores an older response that finishes after a newer filter request", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof searchResponse>>) => void;
    let resolveSecond!: (value: Awaited<ReturnType<typeof searchResponse>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof searchResponse>>>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Awaited<ReturnType<typeof searchResponse>>>((resolve) => { resolveSecond = resolve; });
    vi.mocked(axios.get)
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    renderSearch("/search?keyword=历史");
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "默认排序" }));
    fireEvent.click(screen.getByRole("option", { name: "时间降序" }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    resolveSecond(await searchResponse([{ ...defaultResult, title: "新的结果" }]));
    expect(await screen.findByRole("heading", { name: "新的结果" })).toBeTruthy();

    resolveFirst(await searchResponse([{ ...defaultResult, title: "过期结果" }]));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "过期结果" })).toBeNull();
    expect(screen.getByRole("heading", { name: "新的结果" })).toBeTruthy();
  });

  it("resynchronizes controls and results after history navigation", async () => {
    vi.mocked(axios.get).mockImplementation((_url, config) => {
      const request = (config as { params: { keyword: string } }).params;
      return searchResponse([{ ...defaultResult, title: `${request.keyword}结果` }], 25);
    });
    renderSearch("/search?keyword=第一&page=2");
    await screen.findByRole("heading", { name: "第一结果" });

    fireEvent.click(screen.getByTestId("navigate-second-search"));
    await screen.findByRole("heading", { name: "第二结果" });
    expect((screen.getByPlaceholderText("在JOJO看报上搜索") as HTMLInputElement).value).toBe("第二");
    expect(getLastRequestParams()).toMatchObject({ keyword: "第二", page: 1, sort: "timeDesc" });

    fireEvent.click(screen.getByTestId("navigate-back"));
    await screen.findByRole("heading", { name: "第一结果" });
    expect((screen.getByPlaceholderText("在JOJO看报上搜索") as HTMLInputElement).value).toBe("第一");
    expect(getLastRequestParams()).toMatchObject({ keyword: "第一", page: 2 });
  });
});

describe("SearchPage filters", () => {
  it("enables today only after the daily archive sync cutoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-17T11:00:00Z"));
    renderSearch("/search?keyword=历史&startDate=20260716&endDate=20260717");
    await screen.findByRole("heading", { name: highlightedTitleName });

    fireEvent.click(screen.getByRole("button", { name: "日期范围：2026-07-16 — 2026-07-17" }));
    fireEvent.click(screen.getByRole("button", { name: "开始日期：打开日历" }));
    fireEvent.click(screen.getByRole("button", { name: "2026 年" }));
    expect((screen.getByRole("button", { name: "2026" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "2027年，暂不可选" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "2026" }));
    expect((screen.getByRole("button", { name: "七月" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "八月，暂不可选" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "七月" }));
    expect((screen.getByRole("button", { name: "17" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "18日，暂不可选" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "18日，暂不可选" }));
    expect((screen.getByRole("textbox", { name: "开始日期" }) as HTMLInputElement).value).toBe("2026-07-16");

    fireEvent.click(screen.getByRole("button", { name: "开始日期：打开日历" }));
    fireEvent.click(screen.getByRole("button", { name: "结束日期：打开日历" }));
    expect((screen.getByRole("button", { name: "18日，暂不可选" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("changes sort immediately, resets to page one, and closes the list", async () => {
    renderSearch("/search?keyword=历史&page=3");
    await screen.findByRole("heading", { name: highlightedTitleName });

    const trigger = screen.getByRole("button", { name: "默认排序" });
    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: "默认排序" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "最佳匹配" }));

    await waitFor(() => expect(getLastRequestParams()).toEqual({
      keyword: "历史",
      page: 1,
      size: 10,
      sort: "match",
    }));
    expect(screen.queryByRole("listbox", { name: "排序" })).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/search?keyword=%E5%8E%86%E5%8F%B2&sort=match");
  });

  it("closes the sort menu with Escape and an outside click without searching", async () => {
    renderSearch("/search?keyword=历史");
    await screen.findByRole("heading", { name: highlightedTitleName });
    const initialCalls = vi.mocked(axios.get).mock.calls.length;
    const trigger = screen.getByRole("button", { name: "默认排序" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "排序" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox", { name: "排序" })).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(initialCalls);
  });

  it("sends a changed start date together with the existing end date", async () => {
    renderSearch("/search?keyword=历史&startDate=20260716&endDate=20260717");
    await screen.findByRole("heading", { name: highlightedTitleName });

    fireEvent.click(screen.getByRole("button", { name: "日期范围：2026-07-16 — 2026-07-17" }));
    fireEvent.click(screen.getByRole("button", { name: "开始日期：打开日历" }));
    fireEvent.click(screen.getByRole("button", { name: "15" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "开始日期" }) as HTMLInputElement).value).toBe("2026-07-15"));
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() => expect(getLastRequestParams()).toEqual({
      keyword: "历史",
      page: 1,
      size: 10,
      startDate: "2026-07-15",
      endDate: "2026-07-17",
    }));
    expect(screen.getByTestId("location").textContent).toContain("startDate=20260715");
  });

  it("clears both applied dates and immediately searches without a date range", async () => {
    renderSearch("/search?keyword=梁祝&startDate=19600701&endDate=19940701");
    await screen.findByRole("heading", { name: highlightedTitleName });

    fireEvent.click(screen.getByRole("button", { name: "清除日期" }));

    await waitFor(() => expect(getLastRequestParams()).toEqual({
      keyword: "梁祝",
      page: 1,
      size: 10,
    }));
    expect(screen.queryByRole("button", { name: "清除日期" })).toBeNull();
    expect(screen.getByRole("button", { name: "日期范围：选择日期范围" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/search?keyword=%E6%A2%81%E7%A5%9D");
  });

  it("waits for both dates before applying a date range", async () => {
    renderSearch("/search?keyword=历史");
    await screen.findByRole("heading", { name: highlightedTitleName });
    const callsBeforeDate = vi.mocked(axios.get).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "日期范围：选择日期范围" }));
    fireEvent.click(screen.getByRole("button", { name: "开始日期：打开日历" }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(axios.get).toHaveBeenCalledTimes(callsBeforeDate);
  });

  it("accepts a directly typed historical date range without calendar navigation", async () => {
    renderSearch("/search?keyword=历史");
    await screen.findByRole("heading", { name: highlightedTitleName });
    const callsBeforeDate = vi.mocked(axios.get).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "日期范围：选择日期范围" }));
    const startInput = screen.getByRole("textbox", { name: "开始日期" }) as HTMLInputElement;
    const endInput = screen.getByRole("textbox", { name: "结束日期" }) as HTMLInputElement;

    fireEvent.change(startInput, { target: { value: "1946.9.25" } });
    fireEvent.keyDown(startInput, { key: "Enter" });
    await waitFor(() => expect(startInput.value).toBe("1946-09-25"));
    expect(axios.get).toHaveBeenCalledTimes(callsBeforeDate);

    fireEvent.change(endInput, { target: { value: "1960.5.6" } });
    fireEvent.keyDown(endInput, { key: "Enter" });
    expect(axios.get).toHaveBeenCalledTimes(callsBeforeDate);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() => expect(getLastRequestParams()).toEqual({
      keyword: "历史",
      page: 1,
      size: 10,
      startDate: "1946-09-25",
      endDate: "1960-05-06",
    }));
    expect(endInput.value).toBe("1960-05-06");
    expect(screen.getByTestId("location").textContent).toContain("startDate=19460925&endDate=19600506");
  });

  it("applies a common historical period with one click", async () => {
    renderSearch("/search?keyword=历史");
    await screen.findByRole("heading", { name: highlightedTitleName });

    expect(screen.queryByRole("button", { name: "大跃进" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "日期范围：选择日期范围" }));
    const periodButton = screen.getByRole("button", { name: "大跃进" });
    fireEvent.click(periodButton);

    await waitFor(() => expect(getLastRequestParams()).toEqual({
      keyword: "历史",
      page: 1,
      size: 10,
      startDate: "1958-01-01",
      endDate: "1960-12-31",
    }));
    fireEvent.click(screen.getByRole("button", { name: "日期范围：1958-01-01 — 1960-12-31" }));
    expect(screen.getByRole("button", { name: "大跃进" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("location").textContent).toContain("startDate=19580101&endDate=19601231");
  });
});

describe("SearchPage pagination", () => {
  it("requests the next page, numbers results from 11, updates URL, and scrolls to top", async () => {
    vi.mocked(axios.get).mockImplementation((_url, config) => {
      const page = Number((config as { params: { page: number } }).params.page);
      return searchResponse([{ ...defaultResult, title: `第${page}页结果` }], 25);
    });
    renderSearch("/search?keyword=历史");
    await screen.findByRole("heading", { name: "第1页结果" });
    const container = document.querySelector<HTMLElement>("[data-search-scroll-container]")!;

    fireEvent.click(screen.getByRole("button", { name: "›" }));

    await screen.findByRole("heading", { name: "第2页结果" });
    expect(getLastRequestParams()).toEqual({ keyword: "历史", page: 2, size: 10 });
    expect(screen.getByText("11")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/search?keyword=%E5%8E%86%E5%8F%B2&page=2");
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
