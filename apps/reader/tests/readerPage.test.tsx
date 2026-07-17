import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderPage } from "../src/pages/ReaderPage";

const pdfMocks = vi.hoisted(() => ({
  fetchPdfDownloadBytes: vi.fn(),
  usePdfDocument: vi.fn(),
  viewerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@jojo/pdf-viewer", () => ({
  fetchPdfDownloadBytes: pdfMocks.fetchPdfDownloadBytes,
  usePdfDocument: pdfMocks.usePdfDocument,
  PdfViewer: (props: Record<string, unknown>) => {
    pdfMocks.viewerProps.push(props);
    const document = props.document as { numPages?: number } | null;
    return (
      <div data-testid="pdf-viewer">
        {Array.from({ length: document?.numPages ?? 0 }, (_, index) => (
          <div id={`page-${index + 1}`} key={index + 1} />
        ))}
        <button type="button" onClick={() => (props.onPageChange as (page: number) => void)(5)}>
          模拟看到第5页
        </button>
        <button type="button" onClick={() => (props.onZoomChange as (zoom: number) => void)(2.75)}>
          模拟缩放
        </button>
      </div>
    );
  },
}));

const readyDocument = { numPages: 6 };

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.hash}</output>;
}

function renderReader(
  path: string,
  { type = "newspaper", name = "rmrb" }: { type?: "newspaper" | "magazine"; name?: string } = {},
) {
  window.history.replaceState({}, "", path);
  const route = `/${name}/:id`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={<ReaderPage type={type} name={name} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function latestViewerProps() {
  const props = pdfMocks.viewerProps.at(-1);
  if (!props) throw new Error("PdfViewer was not rendered");
  return props;
}

function setPdfState(overrides: Record<string, unknown> = {}) {
  pdfMocks.usePdfDocument.mockReturnValue({
    document: readyDocument,
    numPages: 6,
    loading: false,
    error: null,
    ...overrides,
  });
}

beforeEach(() => {
  pdfMocks.fetchPdfDownloadBytes.mockReset();
  pdfMocks.usePdfDocument.mockReset();
  pdfMocks.viewerProps.length = 0;
  setPdfState();
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:reader-pdf"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReaderPage document states", () => {
  it("derives a newspaper URL from the route and renders document metadata", () => {
    renderReader("/rmrb/19761009");

    expect(pdfMocks.usePdfDocument).toHaveBeenCalledWith({
      url: "https://blacknews.jojokanbao.cn/RMRB/1976/19761009.pdf",
      protectedPdf: "auto",
    });
    expect(screen.getByText("人民日报 - 19761009")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1976年10月09日" })).toBeTruthy();
    expect(screen.getByText("1 / 6")).toBeTruthy();
    expect(screen.getByLabelText("第 1 页，共 6 页")).toBeTruthy();
    expect(document.title).toBe("人民日报 19761009 - JOJO看报");
    expect(latestViewerProps()).toMatchObject({
      document: readyDocument,
      quality: 3,
      zoom: 1.5,
      zoomEnabled: false,
      initialPage: 1,
    });
  });

  it("does not construct or download a PDF for an invalid route id", () => {
    setPdfState({ document: null, numPages: 0 });
    renderReader("/rmrb/not-a-date");

    expect(pdfMocks.usePdfDocument).toHaveBeenCalledWith({ url: "", protectedPdf: "auto" });
    expect(screen.queryByTestId("pdf-viewer")).toBeNull();
    expect(screen.queryByRole("button", { name: "下载 PDF" })).toBeNull();
    expect(screen.getByRole("button", { name: "选择日期" })).toBeTruthy();
    expect(screen.getByText("阅读链接无效")).toBeTruthy();
    expect(screen.getByText("链接中的日期或期数格式不正确。")).toBeTruthy();
  });

  it("rejects impossible dates and unavailable magazine issues without a PDF request", () => {
    setPdfState({ document: null, numPages: 0 });
    const invalidDate = renderReader("/rmrb/19760231");
    expect(pdfMocks.usePdfDocument).toHaveBeenLastCalledWith({ url: "", protectedPdf: "auto" });
    expect(screen.getByText("链接中的日期不是有效日期。")).toBeTruthy();
    invalidDate.unmount();

    renderReader("/hq/196499", { type: "magazine", name: "hq" });
    expect(pdfMocks.usePdfDocument).toHaveBeenLastCalledWith({ url: "", protectedPdf: "auto" });
    expect(screen.getByText("该年份没有对应的杂志期数。")).toBeTruthy();
  });

  it("shows the loading overlay without rendering the viewer", () => {
    setPdfState({ document: null, numPages: 0, loading: true });
    renderReader("/rmrb/19761009");

    expect(screen.getByText("正在加载 PDF 文档")).toBeTruthy();
    expect(screen.queryByTestId("pdf-viewer")).toBeNull();
  });

  it("shows the PDF error detail instead of the generic message alone", () => {
    setPdfState({ document: null, numPages: 0, error: "Range response has an invalid Content-Range header" });
    renderReader("/rmrb/19761009");

    expect(screen.getByText("没有当天文档或数据缺失")).toBeTruthy();
    expect(screen.getByText("Range response has an invalid Content-Range header")).toBeTruthy();
  });

  it("uses a valid hash as the initial page and ignores an out-of-range hash", () => {
    const first = renderReader("/rmrb/19761009#page-4");
    expect(latestViewerProps().initialPage).toBe(4);
    first.unmount();

    pdfMocks.viewerProps.length = 0;
    renderReader("/rmrb/19761009#page-99");
    expect(latestViewerProps().initialPage).toBe(1);
  });
});

describe("ReaderPage newspaper navigation", () => {
  it("changes to an enabled date and requests only the new route PDF", async () => {
    renderReader("/rmrb/19761009");

    fireEvent.click(screen.getByRole("button", { name: "1976年10月09日" }));
    fireEvent.click(screen.getByRole("button", { name: "8" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/rmrb/19761008"));
    expect(pdfMocks.usePdfDocument).toHaveBeenLastCalledWith({
      url: "https://blacknews.jojokanbao.cn/RMRB/1976/19761008.pdf",
      protectedPdf: "auto",
    });
  });

  it("prevents selecting a publication date known to be missing", () => {
    renderReader("/rmrb/19460627");
    fireEvent.click(screen.getByRole("button", { name: "1946年06月27日" }));

    expect((screen.getByRole("button", { name: "28" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "29" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "30" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ReaderPage magazine navigation", () => {
  it("shows all issues, marks the current one, and navigates to a supplement", async () => {
    renderReader("/hq/196419", { type: "magazine", name: "hq" });

    const trigger = screen.getByRole("button", { name: "第19期" });
    fireEvent.click(trigger);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(26);
    expect(screen.getByRole("option", { name: "第19期" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("option", { name: "增刊1" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/hq/196491"));
    expect(pdfMocks.usePdfDocument).toHaveBeenLastCalledWith({
      url: "https://blacknews.jojokanbao.cn/HQ/1964/196491.pdf",
      protectedPdf: "auto",
    });
  });

  it("closes the issue list with Escape and an outside click", () => {
    renderReader("/hq/196419", { type: "magazine", name: "hq" });
    const trigger = screen.getByRole("button", { name: "第19期" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "期数" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox", { name: "期数" })).toBeNull();
  });

  it("keeps wheel scrolling inside the issue dropdown", () => {
    renderReader("/hq/196419", { type: "magazine", name: "hq" });
    fireEvent.click(screen.getByRole("button", { name: "第19期" }));

    const listbox = screen.getByRole("listbox", { name: "期数" });
    const panel = listbox.parentElement!;
    const reader = document.querySelector<HTMLElement>("[data-reader-scroll-container]")!;
    const readerWheel = vi.fn();
    reader.addEventListener("wheel", readerWheel);
    Object.defineProperties(listbox, {
      clientHeight: { configurable: true, value: 256 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    const scrollEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    panel.dispatchEvent(scrollEvent);
    expect(scrollEvent.defaultPrevented).toBe(true);
    expect(readerWheel).not.toHaveBeenCalled();
    expect(listbox.scrollTop).toBe(120);

    const boundaryEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 600 });
    panel.dispatchEvent(boundaryEvent);
    expect(listbox.scrollTop).toBe(344);
    expect(listbox.className).toContain("overscroll-y-contain");
  });

  it("selects the first available issue when changing magazine year", async () => {
    renderReader("/hq/196419", { type: "magazine", name: "hq" });

    fireEvent.click(screen.getByRole("button", { name: "1964年" }));
    fireEvent.click(screen.getByRole("button", { name: "1965" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/hq/196501"));
  });
});

describe("ReaderPage toolbar interactions", () => {
  it("enables in-place zoom, accepts viewer zoom changes, and exits with Escape", () => {
    renderReader("/rmrb/19761009");

    fireEvent.click(screen.getByRole("button", { name: "开启区域缩放" }));
    expect(latestViewerProps().zoomEnabled).toBe(true);
    expect(screen.getByRole("button", { name: "关闭区域缩放" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "模拟缩放" }));
    expect(latestViewerProps().zoom).toBe(2.75);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(latestViewerProps().zoomEnabled).toBe(false);
    expect(screen.getByRole("button", { name: "开启区域缩放" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("uses clarity 3 by default, limits it to 1-3, and forwards setting changes", () => {
    renderReader("/rmrb/19761009");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const clarity = screen.getByRole("slider", { name: "清晰度" }) as HTMLInputElement;
    expect(clarity.value).toBe("3");
    expect(clarity.min).toBe("1");
    expect(clarity.max).toBe("3");
    fireEvent.change(clarity, { target: { value: "1" } });
    expect(latestViewerProps().quality).toBe(1);
    expect(screen.getByText("清晰度 (1)")).toBeTruthy();

    const zoom = screen.getByRole("slider", { name: "页面缩放" }) as HTMLInputElement;
    expect(zoom.step).toBe("0.25");
    fireEvent.change(zoom, { target: { value: "2.25" } });
    expect(latestViewerProps().zoom).toBe(2.25);
    expect(screen.getByText("页面缩放 (225%)")).toBeTruthy();
  });

  it("does not show the clarity control for publications without resolution control", () => {
    renderReader("/ckxx/19760910", { name: "ckxx" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.queryByRole("slider", { name: "清晰度" })).toBeNull();
    expect(screen.getByRole("slider", { name: "页面缩放" })).toBeTruthy();
  });

  it("closes settings on outside click and when zoom mode is toggled", () => {
    renderReader("/rmrb/19761009");
    const settings = screen.getByRole("button", { name: "设置" });

    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseDown(document.body);
    expect(settings.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(settings);
    fireEvent.click(screen.getByRole("button", { name: "开启区域缩放" }));
    expect(settings.getAttribute("aria-expanded")).toBe("false");
  });

  it("jumps only to an in-range page and updates the shareable hash", async () => {
    renderReader("/rmrb/19761009");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const pageInput = screen.getByRole("spinbutton") as HTMLInputElement;
    const scrollIntoView = HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    scrollIntoView.mockClear();

    fireEvent.change(pageInput, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    expect(window.location.hash).toBe("#page-4");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.change(pageInput, { target: { value: "7" } });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(window.location.hash).toBe("#page-4");
  });

  it("keeps the toolbar, jump field, URL, and shared link synchronized with the visible page", async () => {
    renderReader("/rmrb/19761009");
    fireEvent.click(screen.getByRole("button", { name: "模拟看到第5页" }));

    expect(screen.getByText("5 / 6")).toBeTruthy();
    expect(window.location.hash).toBe("#page-5");

    fireEvent.click(screen.getByRole("button", { name: "复制阅读链接" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://localhost:3000/rmrb/19761009#page-5"));

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("5");
  });

  it("copies the complete reading URL and reports clipboard failures", async () => {
    renderReader("/rmrb/19761009#page-3");
    const share = screen.getByRole("button", { name: "复制阅读链接" });
    fireEvent.click(share);

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://localhost:3000/rmrb/19761009#page-3"));
    expect(screen.getByRole("button", { name: "已复制阅读链接" })).toBeTruthy();

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "已复制阅读链接" }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("复制链接失败，请直接复制浏览器地址栏链接。"));
  });

  it("downloads restored PDF bytes with the route-derived filename", async () => {
    pdfMocks.fetchPdfDownloadBytes.mockResolvedValue({ bytes: new Uint8Array([37, 80, 68, 70]), protected: true });
    let clickedDownload: { href: string; download: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function captureDownload(this: HTMLAnchorElement) {
      clickedDownload = { href: this.href, download: this.download };
    });
    renderReader("/rmrb/19761009");

    fireEvent.click(screen.getByRole("button", { name: "下载 PDF" }));
    await waitFor(() => expect(pdfMocks.fetchPdfDownloadBytes).toHaveBeenCalledWith(
      "https://blacknews.jojokanbao.cn/RMRB/1976/19761009.pdf",
      "auto",
    ));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/pdf" }));
    expect(clickedDownload).toEqual({ href: "blob:reader-pdf", download: "rmrb-19761009.pdf" });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reader-pdf"));
  });

  it("prevents duplicate downloads and surfaces a download error", async () => {
    let rejectDownload!: (error: Error) => void;
    pdfMocks.fetchPdfDownloadBytes.mockReturnValue(new Promise((_, reject) => { rejectDownload = reject; }));
    renderReader("/rmrb/19761009");

    fireEvent.click(screen.getByRole("button", { name: "下载 PDF" }));
    const pendingButton = screen.getByRole("button", { name: "下载中" });
    fireEvent.click(pendingButton);
    expect(pdfMocks.fetchPdfDownloadBytes).toHaveBeenCalledTimes(1);

    rejectDownload(new Error("network unavailable"));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("network unavailable"));
    expect((screen.getByRole("button", { name: "下载 PDF" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows and operates back-to-top only after scrolling down", () => {
    renderReader("/rmrb/19761009");
    const container = document.querySelector<HTMLElement>("[data-reader-scroll-container]")!;
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();

    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 500 });
    fireEvent.scroll(container);
    fireEvent.click(screen.getByRole("button", { name: "回到顶部" }));
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

    container.scrollTop = 200;
    fireEvent.scroll(container);
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
  });
});
