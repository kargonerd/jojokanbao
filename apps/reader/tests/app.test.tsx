import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const appPdfMocks = vi.hoisted(() => ({
  usePdfDocument: vi.fn(),
}));

vi.mock("@jojo/pdf-viewer", () => ({
  fetchPdfDownloadBytes: vi.fn(),
  PdfPage: () => null,
  PdfViewer: () => null,
  usePdfDocument: appPdfMocks.usePdfDocument,
}));

function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  appPdfMocks.usePdfDocument.mockReset();
  appPdfMocks.usePdfDocument.mockReturnValue({ document: null, numPages: 0, loading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Reader App routes and homepage", () => {
  it("renders all publication cards with editorial metadata and accessible covers", () => {
    renderAt("/");
    const expectedCards: Array<[string, string, string]> = [
      ["人民日报", "中国共产党中央委员会", "1946 —"],
      ["参考消息", "新华通讯社", "1957 —"],
      ["红旗", "中国共产党中央委员会", "1958 — 1988"],
      ["人民画报", "人民画报社", "1950 —"],
      ["世界知识", "世界知识出版社", "1934 —"],
    ];

    for (const [title, publisher, year] of expectedCards) {
      const heading = screen.getByRole("heading", { name: title, level: 2 });
      const card = heading.closest(".group")!;
      expect(within(card as HTMLElement).getByRole("img", { name: title })).toBeTruthy();
      expect(within(card as HTMLElement).getByText(publisher)).toBeTruthy();
      expect(within(card as HTMLElement).getByText(year)).toBeTruthy();
    }
  });

  it("opens the selected publication card in the reader", async () => {
    renderAt("/");
    const card = screen.getByRole("heading", { name: "人民画报", level: 2 }).closest(".group")!;
    fireEvent.click(card);

    await waitFor(() => expect(window.location.pathname).toBe("/rmhb/197292"));
    expect(appPdfMocks.usePdfDocument).toHaveBeenLastCalledWith({
      url: "https://blacknews.jojokanbao.cn/RMHB/1972/197292.pdf",
      protectedPdf: "auto",
    });
  });

  it("redirects every publication root to its documented default issue", async () => {
    const defaults: Array<[string, string]> = [
      ["/rmrb", "/rmrb/19701009"],
      ["/ckxx", "/ckxx/19760910"],
      ["/hq", "/hq/196419"],
      ["/rmhb", "/rmhb/197292"],
      ["/sjzs", "/sjzs/196513"],
    ];

    for (const [source, target] of defaults) {
      const view = renderAt(source);
      await waitFor(() => expect(window.location.pathname).toBe(target));
      view.unmount();
      cleanup();
    }
  });

  it("renders the not-found page for unknown routes", () => {
    renderAt("/not-a-reader-route");
    expect(screen.getByRole("heading", { name: "404 Not Found" })).toBeTruthy();
    expect(screen.getByText("前途是光明的，道路是曲折的")).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回首页" }).getAttribute("href")).toBe("/");
  });
});

describe("Reader App navigation", () => {
  it("navigates to search and marks the route active", async () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("link", { name: "搜索" }));

    await waitFor(() => expect(window.location.pathname).toBe("/search"));
    expect(screen.getByPlaceholderText("在JOJO看报上搜索")).toBeTruthy();
    expect(screen.getByRole("link", { name: "搜索" }).className).toContain("text-red");
  });

  it("opens a desktop publication menu and closes it after navigation", async () => {
    renderAt("/");
    const newspaperMenu = screen.getByRole("button", { name: "报纸" });
    fireEvent.focus(newspaperMenu);
    expect(newspaperMenu.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("link", { name: "参考消息" }));
    await waitFor(() => expect(window.location.pathname).toBe("/ckxx/19760910"));
    expect(newspaperMenu.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the mobile menu, navigates, and closes the menu", async () => {
    renderAt("/");
    const menuButton = screen.getByRole("button", { name: "菜单" });
    fireEvent.click(menuButton);
    const feedbackLinks = screen.getAllByRole("link", { name: "反馈" });
    expect(feedbackLinks).toHaveLength(2);

    fireEvent.click(feedbackLinks.at(-1)!);
    await waitFor(() => expect(window.location.pathname).toBe("/support"));
    expect(screen.getByRole("heading", { name: "反馈" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "反馈" })).toHaveLength(1);
  });

  it("returns home through the mobile brand link", async () => {
    renderAt("/support");
    fireEvent.click(screen.getByRole("link", { name: "JOJO看报" }));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByRole("heading", { name: "人民日报", level: 2 })).toBeTruthy();
  });
});

describe("Support page", () => {
  it("keeps feedback, download, memorial, and donation sections available", () => {
    renderAt("/support");

    for (const name of ["反馈", "纪念缅怀", "数据下载", "捐助"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.getByText("974380749")).toBeTruthy();
    expect(screen.getByRole("link", { name: /纪念毛主席诞辰132周年/ }).getAttribute("target")).toBe("_blank");
    expect(screen.getAllByRole("link", { name: "OneDrive下载" })).toHaveLength(5);
    expect(screen.getByRole("img", { name: "微信" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "支付宝" })).toBeTruthy();
  });
});
