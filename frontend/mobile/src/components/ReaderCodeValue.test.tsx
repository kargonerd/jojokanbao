import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderCodeValue } from "./ReaderCodeValue";

const mocks = vi.hoisted(() => ({ name: null as string | null, status: "loading", refresh: vi.fn() }));
vi.mock("react-native", () => ({ Text: "span", Pressable: "button" }));
vi.mock("../account/auth", () => ({
  useMobileReaderName: () => mocks.name,
  useMobileAuthStore: (select: (state: unknown) => unknown) => select({ profileStatus: mocks.status, refreshProfile: mocks.refresh }),
}));
let view: ReactTestRenderer;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await act(async () => view?.unmount()); });

describe("reader code display", () => {
  it.each(["loading", "error"])("keeps the cached name during %s", async (status) => {
    mocks.name = "鬼石栎-KEB";
    mocks.status = status;
    await act(async () => { view = create(<ReaderCodeValue style={{}} />); });
    expect(view.root.findByType("span").props.children).toBe("鬼石栎-KEB");
    expect(view.root.findAllByType("button")).toHaveLength(0);
  });

  it("distinguishes loading from failure and offers a working retry", async () => {
    mocks.name = null;
    mocks.status = "loading";
    mocks.refresh.mockClear();
    await act(async () => { view = create(<ReaderCodeValue style={{}} />); });
    expect(view.root.findByType("span").props.children).toBe("正在读取…");
    mocks.status = "error";
    await act(async () => { view.update(<ReaderCodeValue style={{}} />); });
    expect(view.root.findByType("span").props.children).toBe("暂未读取，点击重试");
    await act(async () => { view.root.findByType("button").props.onPress(); });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
