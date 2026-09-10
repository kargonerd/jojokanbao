import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useArchivePdf } from "../src/archive/useArchivePdf";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@jojo/content", async (importOriginal) => ({
  ...await importOriginal<typeof import("@jojo/content")>(), loadArchivePdf: mocks.load,
}));
afterEach(() => { cleanup(); mocks.load.mockReset(); });

describe("Archive PDF manifest loading", () => {
  it("cancels the previous issue and never exposes its PDF after navigation", async () => {
    const first = { url: "https://cdn.test/first.jox", objectKey: "first.jox" };
    let completeSecond!: (source: typeof first) => void;
    let secondSignal: AbortSignal | undefined;
    mocks.load.mockResolvedValueOnce(first).mockImplementationOnce((_client, _pub, _id, signal) => {
      secondSignal = signal;
      return new Promise((resolve) => { completeSecond = resolve; });
    }).mockResolvedValueOnce({ url: "https://cdn.test/third.jox", objectKey: "third.jox" });
    const snapshots: Array<string | undefined> = [];
    const view = renderHook(({ id }) => {
      const state = useArchivePdf("rmrb", id);
      snapshots.push(state.source?.url);
      return state;
    }, { initialProps: { id: "19761009" } });
    await waitFor(() => expect(view.result.current.source).toEqual(first));
    snapshots.length = 0;
    view.rerender({ id: "19761008" });
    expect(snapshots.every((url) => url === undefined)).toBe(true);
    expect(view.result.current.loading).toBe(true);
    view.rerender({ id: "19761007" });
    await waitFor(() => expect(view.result.current.source?.objectKey).toBe("third.jox"));
    expect(secondSignal?.aborted).toBe(true);
    await act(async () => completeSecond(first));
    expect(view.result.current.source?.objectKey).toBe("third.jox");
  });

  it("reports a missing manifest and leaves the PDF URL empty", async () => {
    mocks.load.mockRejectedValueOnce(new Error("该期报刊暂无 PDF"));
    const { result } = renderHook(() => useArchivePdf("rmrb", "19761009"));
    await waitFor(() => expect(result.current.error).toBe("该期报刊暂无 PDF"));
    expect(result.current.source).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
