import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimesFeed } from "./useTimesFeed";
import { updatedTimesArticleCount, type MobileTimesFeed } from "./times";

const mocks = vi.hoisted(() => ({ cached: vi.fn(), latest: vi.fn(), page: vi.fn(), save: vi.fn(), focused: true, appState: "active" }));
vi.mock("react-native", () => ({ AppState: { get currentState() { return mocks.appState; }, addEventListener: () => ({ remove() {} }) } }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (callback: () => (() => void) | undefined) => {
    const focused = mocks.focused;
    useEffect(() => focused ? callback() : undefined, [callback, focused]);
  } };
});
vi.mock("./times", async (original) => ({ ...await original<typeof import("./times")>(), mobileTimesApi: {
  cachedTimeline: mocks.cached, latestTimeline: mocks.latest, timelinePage: mocks.page, saveTimeline: mocks.save,
} }));
function feed(version: number, ids: string[]): MobileTimesFeed {
  return { index: { formatVersion: "jojo-news-timeline-index/1", updatedAt: String(version), sources: [],
    dates: [{ date: "20260909", object: "day.jox", articleCount: 3, pages: [0, 1].map((page) => ({ object: `${page}.jox`, articleCount: 2 })) }] },
  pages: [{ formatVersion: "jojo-news-timeline-page/1", date: "20260909", page: 0, updatedAt: String(version),
    articles: ids.map((id) => ({ id, title: id, updatedAt: "1" })) as MobileTimesFeed["pages"][number]["articles"] }] };
}
let state: ReturnType<typeof useTimesFeed>;
function Probe({ userId = "reader" }: { userId?: string | null }) { state = useTimesFeed(userId ?? undefined); return null; }
let view: ReactTestRenderer;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.focused = true; mocks.appState = "active";
  mocks.cached.mockResolvedValue(feed(1, ["old"]));
  mocks.latest.mockReturnValue(new Promise(() => undefined));
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); });

describe("cached times feed with update notice", () => {
  it("shows the previous feed before a stalled background refresh completes, then waits for acceptance", async () => {
    let finish!: (value: MobileTimesFeed) => void;
    mocks.latest.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { view = create(<Probe />); });
    expect(state.loading).toBe(false);
    expect(state.pages[0]?.articles[0]?.id).toBe("old");
    const next = feed(2, ["new", "old"]);
    await act(async () => finish(next));
    expect(state.pages[0]?.articles[0]?.id).toBe("old");
    expect(updatedTimesArticleCount(state.pages, state.pendingLatest!.pages[0]!.articles)).toBe(1);
    await act(async () => state.applyLatest());
    expect(state.pages[0]?.articles[0]?.id).toBe("new");
    expect(state.pendingLatest).toBeNull();
    expect(mocks.save).toHaveBeenLastCalledWith(next);
  });

  it("keeps old news after background and manual failures and checks again after reconnection", async () => {
    mocks.latest.mockRejectedValue(new Error("offline"));
    await act(async () => { view = create(<Probe />); });
    expect(state.error).toBe("");
    await act(async () => state.refresh());
    expect(state.pages[0]?.articles[0]?.id).toBe("old");
    expect(state.error).toContain("缓存");
    mocks.latest.mockResolvedValue(feed(2, ["new", "old"]));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(state.pendingLatest?.index.updatedAt).toBe("2");
    expect(state.pages[0]?.articles[0]?.id).toBe("old");
  });

  it("does not append a stale pagination response after applying an update", async () => {
    mocks.latest.mockResolvedValue(feed(2, ["new", "old"]));
    let finish!: (value: MobileTimesFeed["pages"][number]) => void;
    mocks.page.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { view = create(<Probe />); });
    let more!: Promise<void>;
    await act(async () => { more = state.loadMore(); });
    await act(async () => state.applyLatest());
    await act(async () => { finish({ ...feed(1, ["old-page"]).pages[0]!, page: 1 }); await more; });
    expect(state.pages.flatMap((page) => page.articles.map((item) => item.id))).toEqual(["new", "old"]);
    expect(state.loadingMore).toBe(false);
  });

  it("stops background checks while hidden and ignores a late result after logout", async () => {
    let finish!: (value: MobileTimesFeed) => void;
    mocks.latest.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { view = create(<Probe />); });
    await act(async () => view.update(<Probe userId={null} />));
    await act(async () => finish(feed(2, ["new"])));
    expect(state.pages).toEqual([]);
    expect(state.pendingLatest).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.latest).toHaveBeenCalledOnce();
  });
});
