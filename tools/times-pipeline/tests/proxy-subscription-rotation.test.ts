import { describe, expect, it } from "vitest";
import { parseProxySubscriptionUrls, selectProxySubscription } from "../src/proxy-subscription-rotation.js";

const primary = "https://one.example/sub?private-token";
const secondary = "https://two.example/sub?other-private-token";
const third = "https://three.example/sub?third-private-token";

describe("subscription array configuration", () => {
  it("trims and deduplicates URLs while preserving list order, with legacy single-URL compatibility", () => {
    expect(parseProxySubscriptionUrls(JSON.stringify([primary, ` ${secondary} `, primary, third])))
      .toEqual([primary, secondary, third]);
    expect(parseProxySubscriptionUrls(` ${primary} `)).toEqual([primary]);
  });

  it.each(["", "[]", "null", "{}", '"https://private-token"', "[null]", "[1]", '[""]', '["  "]', '["private-token", 1]', '["private-token"'])
  ("rejects malformed configuration without exposing its contents (%s)", (value) => {
    expect(() => parseProxySubscriptionUrls(value))
      .toThrow(/^Proxy subscriptions must be a non-empty JSON array of URL strings$/);
  });
});

describe("per-Capture subscription rotation", () => {
  it.each([2, 3, 5])("rotates across %s providers and wraps through all fallback candidates", (count) => {
    const urls = Array.from({ length: count }, (_, index) => `https://provider-${index}.example/sub`);
    for (let run = 1; run <= count * 2; run += 1) {
      const options = { urls, runNumber: String(run) };
      const preferred = selectProxySubscription(options);
      expect(preferred).toEqual({ url: urls[(run - 1) % count],
        slot: (run - 1) % count, count, rotationOffset: 0 });
      expect(selectProxySubscription(options)).toEqual(preferred);
      const candidates = Array.from({ length: count }, (_, offset) => selectProxySubscription({ ...options, rotationOffset: String(offset) }));
      expect(candidates.map((candidate) => candidate.slot)).toEqual(Array.from({ length: count }, (_, offset) => (run - 1 + offset) % count));
      expect(new Set(candidates.map((candidate) => candidate.url)).size).toBe(count);
    }
  });

  it.each([primary, JSON.stringify([primary]), JSON.stringify([primary, ` ${primary} `])])("keeps single-provider configuration compatible (%s)", (value) => {
    const urls = parseProxySubscriptionUrls(value);
    expect(selectProxySubscription({ urls, runNumber: "8" }))
      .toEqual({ url: primary, slot: 0, count: 1, rotationOffset: 0 });
    expect(() => selectProxySubscription({ urls, rotationOffset: "1" })).toThrow("offset");
  });

  it("allows a healthy provider when only the other URL is malformed and redacts validation errors", () => {
    expect(selectProxySubscription({ urls: [primary, "private-token"], runNumber: "1" }).url).toBe(primary);
    expect(() => selectProxySubscription({ urls: [primary, "private-token"], runNumber: "2" }))
      .toThrow(/^Proxy subscription URL is invalid$/);
    expect(selectProxySubscription({ urls: ["private-token", secondary], rotationOffset: "1" }).url).toBe(secondary);
    expect(() => selectProxySubscription({ urls: ["file:///private-token"] })).toThrow(/^Proxy subscription URL is invalid$/);
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("rejects invalid run numbers (%s)", (runNumber) => {
    expect(() => selectProxySubscription({ urls: [primary, secondary], runNumber })).toThrow("run number");
  });

  it.each(["-1", "2", "0.5", "NaN"])("rejects out-of-range offsets (%s)", (rotationOffset) => {
    expect(() => selectProxySubscription({ urls: [primary, secondary], rotationOffset })).toThrow("offset");
  });
});
