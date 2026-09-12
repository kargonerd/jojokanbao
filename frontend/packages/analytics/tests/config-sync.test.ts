import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startConfigSync } from "../src/config-sync";
import type { FlagSession } from "../src/flags";

let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
const parse = (value: unknown) => typeof value === "object" && value !== null && "qqGroup" in value
  && typeof value.qqGroup === "string" && /^[1-9][0-9]{4,11}$/.test(value.qqGroup) ? {qqGroup: value.qqGroup} : undefined;

it("restores validated disk cache even if the SDK cannot load", async () => {
  const publish = vi.fn();
  const open = vi.fn(async () => { throw new Error("offline chunk load"); });
  const sync = startConfigSync({open, parse, publish, foreground: () => true,
    cache: {read: async () => ({qqGroup: "123456789"}), write: vi.fn()}});
  stop = sync.stop;
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledExactlyOnceWith({qqGroup: "123456789"});
  expect(open).toHaveBeenCalledOnce();
});

it("rejects malformed SDK cache and remote responses, persists only valid updates and throttles foreground refresh", async () => {
  let onPayload: (value: unknown) => void = () => undefined;
  let active = true;
  const session = {cached: () => ({qqGroup: 12345}), subscribe: (listener: typeof onPayload) => {
    onPayload = listener; return vi.fn();
  }, refresh: vi.fn(), dispose: vi.fn()};
  const write = vi.fn(async () => undefined), publish = vi.fn();
  const sync = startConfigSync({open: async () => session, parse, publish, foreground: () => active,
    cache: {read: async () => ({qqGroup: "123456789"}), write}});
  stop = sync.stop;
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledExactlyOnceWith({qqGroup: "123456789"});
  for (const value of [undefined, null, {}, {qqGroup: ""}, {qqGroup: "0"}, {qqGroup: "1234"}, {qqGroup: "1234567890123"}]) onPayload(value);
  expect(write).not.toHaveBeenCalled();
  onPayload({qqGroup: "987654321"});
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith({qqGroup: "987654321"});
  expect(write).toHaveBeenCalledExactlyOnceWith({qqGroup: "987654321"});
  sync.refresh(); expect(session.refresh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  active = false; sync.refresh(); expect(session.refresh).toHaveBeenCalledOnce();
  active = true; sync.refresh(); expect(session.refresh).toHaveBeenCalledTimes(2);
  sync.stop(); onPayload({qqGroup: "543219876"});
  expect(publish).toHaveBeenCalledTimes(2);
});

it("disposes a late SDK initialization after unmount without publishing or starting a request", async () => {
  let resolve!: (session: FlagSession<unknown>) => void;
  const session = {cached: vi.fn(), subscribe: vi.fn(), refresh: vi.fn(), dispose: vi.fn()};
  const sync = startConfigSync({open: () => new Promise(done => { resolve = done; }), parse,
    publish: vi.fn(), foreground: () => true, cache: {read: async () => null, write: vi.fn()}});
  stop = sync.stop;
  await vi.advanceTimersByTimeAsync(0);
  sync.stop(); resolve(session);
  await vi.advanceTimersByTimeAsync(0);
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(session.cached).not.toHaveBeenCalled();
  expect(session.refresh).not.toHaveBeenCalled();
});
