import { describe, expect, it } from "vitest";
import { parseArchiveReaderUrl, readerBootstrapScript } from "./readerBridge";

describe("native reader bridge", () => {
  it("parses canonical archive reader URLs", () => {
    expect(parseArchiveReaderUrl("https://reader.jojokanbao.cn/archive/rmrb/19660701#page-5")).toEqual({
      publication: "rmrb",
      issueId: "19660701",
    });
    expect(parseArchiveReaderUrl("https://example.com/account")).toBeNull();
  });

  it("injects the native shell and build-fixed e-ink behavior", () => {
    const script = readerBootstrapScript({ eInkRelease: true, textScale: 1.12 });
    expect(script).toContain("jojo-native-eink");
    expect(script).toContain("filter: grayscale(1)");
    expect(script).toContain("element.querySelector('nav')");
    expect(script).toContain("MutationObserver");
    expect(script).toContain("1.12");
  });

  it("waits for DOM readiness when the early Android injection has no head", () => {
    const listeners = new Map<string, () => void>();
    const appended: Array<{ id: string; textContent?: string }> = [];
    const root = {
      classList: { toggle: () => undefined },
      style: { setProperty: () => undefined },
    };
    const document = {
      readyState: "loading",
      documentElement: root,
      head: null as null | { appendChild: (element: { id: string; textContent?: string }) => void },
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      createElement: () => ({ id: "", textContent: "" }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    class MutationObserverStub {
      constructor(_callback: () => void) {}
      observe() {}
      disconnect() {}
    }
    const window = { ReactNativeWebView: undefined };
    const run = new Function("document", "window", "MutationObserver", "location", "addEventListener", readerBootstrapScript({
      eInkRelease: true,
      textScale: 1,
    }));

    expect(() => run(document, window, MutationObserverStub, { href: "https://reader.example/archive/rmrb/19660701" }, () => undefined)).not.toThrow();
    expect(appended).toHaveLength(0);

    document.head = { appendChild: (element) => appended.push(element) };
    listeners.get("DOMContentLoaded")?.();
    expect(appended).toEqual([{ id: "jojo-native-reader-style", textContent: expect.any(String) }]);
  });
});
