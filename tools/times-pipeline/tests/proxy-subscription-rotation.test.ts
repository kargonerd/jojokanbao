import { describe, expect, it } from "vitest";
import { selectProxySubscription } from "../src/proxy-subscription-rotation.js";

const primary = "https://one.example/sub?private-token";
const secondary = "https://two.example/sub?other-private-token";

describe("per-Capture subscription rotation", () => {
  it("alternates preferred providers while keeping their cache slots stable", () => {
    for (let run = 1; run <= 6; run += 1) {
      const options = { primary, secondary, runNumber: String(run) };
      const preferred = selectProxySubscription(options);
      expect(preferred).toEqual({ url: run % 2 ? primary : secondary,
        slot: (run - 1) % 2, count: 2, rotationOffset: 0 });
      expect(selectProxySubscription(options)).toEqual(preferred);
      expect(selectProxySubscription({ ...options, rotationOffset: "1" })).toEqual({
        url: run % 2 ? secondary : primary, slot: run % 2, count: 2, rotationOffset: 1,
      });
    }
  });

  it.each([undefined, "", "  ", primary, ` ${primary} `])("keeps single-provider configuration compatible (%s)", (secondary) => {
    expect(selectProxySubscription({ primary, secondary, runNumber: "8" }))
      .toEqual({ url: primary, slot: 0, count: 1, rotationOffset: 0 });
    expect(() => selectProxySubscription({ primary, secondary, rotationOffset: "1" })).toThrow("offset");
  });

  it("allows a healthy provider when only the other URL is malformed and redacts validation errors", () => {
    expect(selectProxySubscription({ primary, secondary: "private-token", runNumber: "1" }).url).toBe(primary);
    expect(() => selectProxySubscription({ primary, secondary: "private-token", runNumber: "2" }))
      .toThrow(/^Proxy subscription URL is invalid$/);
    expect(selectProxySubscription({ primary: "private-token", secondary, rotationOffset: "1" }).url).toBe(secondary);
    expect(() => selectProxySubscription({ primary: "file:///private-token" })).toThrow(/^Proxy subscription URL is invalid$/);
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("rejects invalid run numbers (%s)", (runNumber) => {
    expect(() => selectProxySubscription({ primary, secondary, runNumber })).toThrow("run number");
  });

  it.each(["-1", "2", "0.5", "NaN"])("rejects out-of-range offsets (%s)", (rotationOffset) => {
    expect(() => selectProxySubscription({ primary, secondary, rotationOffset })).toThrow("offset");
  });
});
