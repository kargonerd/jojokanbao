import { StrictMode } from "react";
import { act, cleanup, fireEvent, isInaccessible, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seenKey = "jojo:commemoration:1976-2026:seen";
const dialogDescriptors = Object.fromEntries(["showModal", "close"].map((key) => [key, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key)]));
let LaunchCommemoration: typeof import("../src/home/LaunchCommemoration").LaunchCommemoration;
let media: MediaQueryList;
let motionListener: (() => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_RELEASE_CHANNEL", "stable");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.setSystemTime(new Date("2026-09-09T00:00:00+08:00"));
  window.localStorage.clear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  motionListener = undefined;
  media = {
    matches: false,
    addEventListener: vi.fn((_event: string, listener: () => void) => { motionListener = listener; }),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  } });
  ({ LaunchCommemoration } = await import("../src/home/LaunchCommemoration"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const [key, descriptor] of Object.entries(dialogDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
  document.body.style.overflow = "";
  document.documentElement.removeAttribute("data-commemoration-tone");
  document.documentElement.removeAttribute("data-commemoration-paused");
});

function renderOpening() {
  return render(<><input id="app-home-search" aria-label="搜索书名" /><LaunchCommemoration /></>);
}

describe("commemorative launch opening", () => {
  it.each([
    ["beta.jojokanbao.cn", "stable", false],
    ["preview.example.com", "beta", false],
    ["beta.jojokanbao.cn", "stable", true],
    ["preview.example.com", "beta", true],
  ] as const)("skips the opening on %s in the %s channel (DEV=%s) without changing presentation or playback records", (hostname, channel, development) => {
    vi.stubGlobal("location", new URL(`https://${hostname}/`));
    vi.stubEnv("VITE_RELEASE_CHANNEL", channel);
    vi.stubEnv("DEV", development);
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    const writeStorage = vi.spyOn(Storage.prototype, "setItem");
    renderOpening();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.documentElement.hasAttribute("data-commemoration-tone")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(readStorage).not.toHaveBeenCalled();
    expect(writeStorage).not.toHaveBeenCalled();
  });

  it.each([null, "1"])("skips the opening and reloads in development without reading or changing an existing %s playback record", async (record) => {
    vi.stubEnv("DEV", true);
    if (record) window.localStorage.setItem(seenKey, record);
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    const writeStorage = vi.spyOn(Storage.prototype, "setItem");
    const view = renderOpening();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.documentElement.hasAttribute("data-commemoration-tone")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    view.unmount();

    vi.resetModules();
    const { LaunchCommemoration: ReloadedOpening } = await import("../src/home/LaunchCommemoration");
    render(<StrictMode><ReloadedOpening /></StrictMode>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readStorage).not.toHaveBeenCalled();
    expect(writeStorage).not.toHaveBeenCalled();
  });

  it("autoplays once throughout September in Beijing, with no permanent entrance or replay after a reload", async () => {
    vi.setSystemTime(new Date("2026-08-31T15:59:59.999Z"));
    let view = render(<LaunchCommemoration />);
    expect(view.container.innerHTML).toBe("");
    view.unmount();

    vi.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    view = render(<LaunchCommemoration />);
    expect(view.container.innerHTML).toBe("");
    view.unmount();

    vi.setSystemTime(new Date("2026-08-31T16:00:00Z"));
    view = render(<StrictMode><input id="app-home-search" aria-label="搜索书名" /><LaunchCommemoration /></StrictMode>);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(window.localStorage.getItem(seenKey)).toBe("1");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    fireEvent.click(screen.getByRole("button", { name: "跳过动画" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.hasAttribute("data-commemoration-tone")).toBe(false);
    expect(document.documentElement.hasAttribute("data-commemoration-paused")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索书名" }));
    view.unmount();

    vi.resetModules();
    const { LaunchCommemoration: ReloadedOpening } = await import("../src/home/LaunchCommemoration");
    view = render(<ReloadedOpening />);
    expect(view.container.innerHTML).toBe("");
    view.unmount();
    vi.setSystemTime(new Date("2026-09-30T12:00:00+08:00"));
    view = render(<ReloadedOpening />);
    expect(view.container.innerHTML).toBe("");
  });

  it.each([
    "2026-09-08T12:00:00+08:00",
    "2026-09-15T12:00:00+08:00",
    "2026-09-30T15:59:59.999Z",
  ])("allows a first visit within September in Beijing at %s", (date) => {
    vi.setSystemTime(new Date(date));
    renderOpening();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(window.localStorage.getItem(seenKey)).toBe("1");
  });

  it("pauses at the same point and automatically returns to reading after one complete sequence", () => {
    renderOpening();
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
    expect(document.documentElement.dataset.commemorationPaused).toBe("true");
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.getByRole("heading", { name: /纪念毛主席/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /进入新版/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "继续播放" }));
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.getByRole("heading", { name: /纪念毛主席/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /雄关漫道真如铁/ })).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("heading", { name: /雄关漫道真如铁/ })).toBeTruthy();
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    expect(document.documentElement.dataset.commemorationPaused).toBe("false");
    act(() => vi.advanceTimersByTime(8999));
    expect(screen.getByRole("heading", { name: /雄关漫道真如铁/ })).toBeTruthy();
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    act(() => vi.advanceTimersByTime(1));
    expect(document.documentElement.dataset.commemorationTone).toBe("renewal");
    act(() => vi.advanceTimersByTime(9999));
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.hasAttribute("data-commemoration-tone")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索书名" }));
  });

  it("holds the quote in grayscale, then reveals the upgrade message as color starts, respecting pauses", () => {
    renderOpening();
    act(() => vi.advanceTimersByTime(7000));
    act(() => vi.advanceTimersByTime(7000));
    expect(screen.getByRole("heading", { name: /雄关漫道真如铁/ })).toBeTruthy();
    expect(isInaccessible(screen.getByText("焕新升级"))).toBe(true);
    expect(screen.queryByRole("button", { name: /进入新版/ })).toBeNull();
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
    act(() => vi.advanceTimersByTime(30000));
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    expect(isInaccessible(screen.getByText("焕新升级"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "继续播放" }));
    act(() => vi.advanceTimersByTime(1999));
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    act(() => vi.advanceTimersByTime(1));
    expect(document.documentElement.dataset.commemorationTone).toBe("renewal");
    expect(isInaccessible(screen.getByText("焕新升级"))).toBe(false);
    act(() => vi.advanceTimersByTime(4000));
    fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.documentElement.dataset.commemorationPaused).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "继续播放" }));
    act(() => vi.advanceTimersByTime(5999));
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pauses while hidden and does not reopen after Escape or returning to the homepage", () => {
    const view = renderOpening();
    act(() => vi.advanceTimersByTime(1000));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.getByRole("heading", { name: /纪念毛主席/ })).toBeTruthy();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole("heading", { name: /雄关漫道真如铁/ })).toBeTruthy();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    renderOpening();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("skips initial reduced motion and keeps both quotes readable if the preference changes mid-playback", () => {
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    const view = renderOpening();
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    Object.defineProperty(media, "matches", { configurable: true, value: false });
    renderOpening();
    act(() => {
      Object.defineProperty(media, "matches", { configurable: true, value: true });
      motionListener?.();
    });
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByRole("heading", { name: /纪念毛主席/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /雄关漫道真如铁/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "暂停动画" })).toBeNull();
    expect(document.documentElement.dataset.commemorationTone).toBe("color");
    fireEvent.click(screen.getByRole("button", { name: /进入新版/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["getItem", "setItem"] as const)("skips playback if storage %s is blocked, avoiding repeated openings", (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("blocked"); });
    document.body.style.overflow = "clip";
    const view = renderOpening();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("clip");
    view.unmount();
    renderOpening();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves legacy WebViews without dialog support untouched", () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
    const view = render(<LaunchCommemoration />);
    expect(view.container.innerHTML).toBe("");
  });

  it("restores page presentation when navigating away during the opening", () => {
    document.documentElement.dataset.commemorationTone = "color";
    document.documentElement.dataset.commemorationPaused = "false";
    const view = renderOpening();
    expect(document.documentElement.dataset.commemorationTone).toBe("memorial");
    view.unmount();
    expect(document.documentElement.dataset.commemorationTone).toBe("color");
    expect(document.documentElement.dataset.commemorationPaused).toBe("false");
  });
});
