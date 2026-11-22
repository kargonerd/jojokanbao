import { afterEach, describe, expect, it, vi } from "vitest";
import { syncBrowserBottomInset } from "../src/shell/browserBottomInset";

const VAR_NAME = "--app-browser-inset-bottom";

function stageViewport(innerHeight: number, height: number, offsetTop = 0) {
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(innerHeight);
  const visual = Object.assign(new EventTarget(), { height, offsetTop });
  vi.stubGlobal("visualViewport", visual);
  return visual;
}

const appliedInset = () => document.documentElement.style.getPropertyValue(VAR_NAME);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(VAR_NAME);
});

describe("syncBrowserBottomInset", () => {
  it("measures an overlaying browser toolbar and drops the variable on cleanup", () => {
    stageViewport(744, 696);
    const stop = syncBrowserBottomInset();
    expect(appliedInset()).toBe("48px");
    stop();
    expect(appliedInset()).toBe("");
  });

  it("follows the visible viewport while the page scrolls", () => {
    const visual = stageViewport(744, 744);
    const stop = syncBrowserBottomInset();
    expect(appliedInset()).toBe("0px");
    visual.height = 700;
    visual.offsetTop = 44;
    visual.dispatchEvent(new Event("resize"));
    expect(appliedInset()).toBe("0px");
    visual.offsetTop = 0;
    visual.dispatchEvent(new Event("scroll"));
    expect(appliedInset()).toBe("44px");
    stop();
  });

  it("ignores an on-screen keyboard instead of lifting the navigation above it", () => {
    stageViewport(744, 400);
    const stop = syncBrowserBottomInset();
    expect(appliedInset()).toBe("0px");
    stop();
  });
});
