import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, AppRoutes } from "../src/App";
import { buildAppNavigationItems } from "../src/shell/AppLayout";

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

describe("JOJO Web routes and Archive homepage", () => {
  it("keeps the complete previous site active when the redesign build flag is off", async () => {
    const home = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes platformRedesign={false} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "人民日报", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "今天读什么？" })).toBeNull();
    expect(screen.queryByRole("link", { name: "登录" })).toBeNull();
    home.unmount();

    render(
      <MemoryRouter initialEntries={["/archive/support"]}>
        <AppRoutes platformRedesign={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "反馈" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "关于 JOJO 看报" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "返回旧版" })).toBeNull();
  });

  it("renders the new reading-first homepage at the site root", () => {
    renderAt("/");

    expect(screen.getByRole("heading", { name: "今天读什么？" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("link", { name: "资料库" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agent" })).toBeNull();
  });

  it("does not expose the previous interface through the legacy entry", async () => {
    renderAt("/legacy");

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByRole("heading", { name: "今天读什么？" })).toBeTruthy();
  });

  it("moves the Archive index to the redesigned library", async () => {
    renderAt("/archive");
    await waitFor(() => expect(window.location.pathname).toBe("/library"));
    expect(screen.getByRole("region", { name: "馆藏列表" })).toBeTruthy();
  });

  it("redirects every publication root to its documented default issue", async () => {
    const defaults: Array<[string, string]> = [
      ["/archive/rmrb", "/archive/rmrb/19761009"],
      ["/archive/ckxx", "/archive/ckxx/19760910"],
      ["/archive/hq", "/archive/hq/196419"],
      ["/archive/rmhb", "/archive/rmhb/197292"],
      ["/archive/sjzs", "/archive/sjzs/196513"],
    ];

    for (const [source, target] of defaults) {
      const view = renderAt(source);
      await waitFor(() => expect(window.location.pathname).toBe(target));
      view.unmount();
      cleanup();
    }
  });

  it("keeps legacy Reader links working and moves them to the canonical route", async () => {
    renderAt("/rmrb/19761009?from=bookmark#page-5");

    await waitFor(() => expect(window.location.pathname).toBe("/archive/rmrb/19761009"));
    expect(window.location.search).toBe("?from=bookmark");
    expect(window.location.hash).toBe("#page-5");
    await waitFor(() => expect(appPdfMocks.usePdfDocument).toHaveBeenLastCalledWith({
      url: "https://blacknews.jojokanbao.cn/RMRB/1976/19761009.pdf",
      protectedPdf: "auto",
    }));
  });

  it("redirects the superseded /reader prefix to Archive", async () => {
    renderAt("/reader/hq/196419?from=preview#page-2");

    await waitFor(() => expect(window.location.pathname).toBe("/archive/hq/196419"));
    expect(window.location.search).toBe("?from=preview");
    expect(window.location.hash).toBe("#page-2");
  });

  it("redirects the exact /reader route to the redesigned library", async () => {
    renderAt("/reader");

    await waitFor(() => expect(window.location.pathname).toBe("/library"));
  });

  it("keeps unfinished modules disabled by default", () => {
    for (const path of ["/rag", "/times"]) {
      const view = renderAt(path);
      expect(screen.getByRole("heading", { name: "404 Not Found" })).toBeTruthy();
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

describe("JOJO Web navigation", () => {
  it("shows AI and Times only to signed-in readers and keeps About last", () => {
    expect(buildAppNavigationItems(false, { rag: true, times: true }).map((item) => item.label)).toEqual([
      "首页", "资料库", "搜索", "关于",
    ]);
    expect(buildAppNavigationItems(true, { rag: true, times: true }).map((item) => item.label)).toEqual([
      "首页", "资料库", "搜索", "AI", "时事", "关于",
    ]);
  });

  it("keeps the login entry visible", () => {
    renderAt("/archive");

    expect(screen.getByRole("link", { name: "登录" }).getAttribute("href")).toBe("/account");
  });

  it("keeps the account route visible when local auth configuration is absent", () => {
    renderAt("/account");

    expect(screen.getByRole("heading", { name: "登录服务未配置" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /返回首页/ }).getAttribute("href")).toBe("/");
  });

  it("keeps the app navigation neutral inside a publication reader", () => {
    renderAt("/archive/hq/196419");

    const homeLink = screen.getByRole("link", { name: "首页" });
    expect(homeLink.classList.contains("is-active")).toBe(false);
    expect(screen.getByRole("link", { name: "资料库" }).classList.contains("is-active")).toBe(false);
    expect(screen.queryByRole("button", { name: "杂志" })).toBeNull();
  });

  it("navigates to search and marks the route active", async () => {
    renderAt("/archive");
    fireEvent.click(screen.getByRole("link", { name: "搜索" }));

    await waitFor(() => expect(window.location.pathname).toBe("/search"));
    expect(screen.getByPlaceholderText("在JOJO看报上搜索")).toBeTruthy();
    expect(screen.getByRole("link", { name: "搜索" }).className).toContain("is-active");
  });

  it("opens the library from the archive through the shared navigation", async () => {
    renderAt("/archive");
    fireEvent.click(screen.getByRole("link", { name: "资料库" }));

    await waitFor(() => expect(window.location.pathname).toBe("/library"));
    expect(screen.getByRole("link", { name: "资料库" }).className).toContain("is-active");
  });

  it("uses the same About entry instead of the old feedback menu", async () => {
    renderAt("/archive");
    expect(screen.queryByRole("button", { name: "菜单" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "关于" }));

    await waitFor(() => expect(window.location.pathname).toBe("/support"));
    expect(screen.getByRole("heading", { name: "关于 JOJO 看报" })).toBeTruthy();
  });

  it("returns home through the mobile brand link", async () => {
    renderAt("/archive/support");
    fireEvent.click(screen.getByRole("link", { name: "JOJO 看报首页" }));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByRole("heading", { name: "今天读什么？" })).toBeTruthy();
  });
});

describe("Support page", () => {
  it("keeps feedback, download, memorial, and donation sections available", () => {
    renderAt("/archive/support");

    for (const name of ["关于 JOJO 看报", "纪念缅怀", "数据下载", "捐助"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: "打开旧版 JOJO 看报" })).toBeNull();
    expect(screen.queryByText("开源项目")).toBeNull();
    expect(screen.queryByRole("link", { name: "GitHub 查看源码" })).toBeNull();
    expect(screen.getByText("974380749")).toBeTruthy();
    expect(screen.getByRole("link", { name: /纪念毛主席诞辰132周年/ }).getAttribute("target")).toBe("_blank");
    expect(screen.getAllByRole("link", { name: "OneDrive下载" })).toHaveLength(5);
    expect(screen.getByRole("img", { name: "微信" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "支付宝" })).toBeTruthy();
  });
});
