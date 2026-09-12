import { describe, expect, it, vi } from "vitest";
import { disabledFlags, FeatureFlagRuntime, flagValues, type FlagSession, type FeatureFlagValues } from "../src/flags";

function session(initial: Record<string, unknown> = {}) {
  let flags = flagValues(initial);
  let listener: ((value: FeatureFlagValues) => void) | undefined;
  return {
    cached: () => flags,
    subscribe: (next: typeof listener) => { listener = next; return () => { listener = undefined; }; },
    refresh: vi.fn(), dispose: vi.fn(),
    update(value: Record<string, unknown>) { flags = flagValues(value); listener?.(flags); },
  };
}

describe("cached product flags", () => {
  it("maps the PostHog key namespace and rejects non-boolean or unknown values", () => {
    expect(flagValues({ library_bookshelf: true, reader_annotations: true, reader_speech: true }))
      .toEqual({ "library.bookshelf": true, "reader.annotations": true, "reader.speech": true });
    expect(flagValues({ library_bookshelf: "true", reader_annotations: 1, "reader.speech": true }))
      .toEqual(disabledFlags());
  });

  it("publishes persisted decisions before background refresh; false and missing keys turn off", async () => {
    const sdk = session({ "reader_speech": true });
    const publish = vi.fn();
    const runtime = new FeatureFlagRuntime(async () => sdk, publish);
    await runtime.setUser("a");
    expect(publish).toHaveBeenLastCalledWith({ ...disabledFlags(), "reader.speech": true });
    expect(sdk.refresh).toHaveBeenCalledTimes(1);
    // A hanging/failed request does not clear the cached view.
    sdk.refresh.mockImplementation(() => { throw new Error("offline"); });
    runtime.refresh(true);
    expect(publish).toHaveBeenLastCalledWith({ ...disabledFlags(), "reader.speech": true });
    sdk.update({ "reader_speech": false, "library_bookshelf": true });
    expect(publish).toHaveBeenLastCalledWith({ ...disabledFlags(), "library.bookshelf": true });
    sdk.update({});
    expect(publish).toHaveBeenLastCalledWith(disabledFlags());
    runtime.stop();
  });

  it("clears immediately on account change, ignores late hydration and never opens for guests", async () => {
    const a = session({ "reader_speech": true });
    const b = session();
    let finish!: (value: FlagSession) => void;
    const open = vi.fn().mockImplementationOnce(() => new Promise<FlagSession>((resolve) => { finish = resolve; })).mockResolvedValue(b);
    const publish = vi.fn();
    const runtime = new FeatureFlagRuntime(open, publish);
    const pending = runtime.setUser("a");
    await runtime.setUser("b");
    finish(a);
    await pending;
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith(disabledFlags());
    b.update({ "reader_speech": true });
    await runtime.setUser(null);
    expect(publish).toHaveBeenLastCalledWith(disabledFlags());
    b.update({ "reader_speech": true });
    expect(publish).toHaveBeenLastCalledWith(disabledFlags());
    expect(open).toHaveBeenCalledTimes(2);
    runtime.stop();
  });

  it("does not rehydrate or refetch on duplicate auth and focus events", async () => {
    const sdk = session();
    const open = vi.fn(async () => sdk);
    const runtime = new FeatureFlagRuntime(open, vi.fn());
    const pending = runtime.setUser("a");
    await runtime.setUser("a");
    await pending;
    await runtime.setUser("a");
    runtime.refresh();
    expect(open).toHaveBeenCalledOnce();
    expect(sdk.refresh).toHaveBeenCalledOnce();
    runtime.stop();
  });
});
