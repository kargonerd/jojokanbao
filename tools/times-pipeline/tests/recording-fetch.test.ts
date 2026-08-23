import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { normalizeEncodedResponse } from "../src/recording-fetch.js";

describe("recording fetch", () => {
  it("decompresses an upstream gzip body even when the encoding header is missing", async () => {
    const response = new Response(Uint8Array.from(gzipSync("<rss><channel /></rss>")).buffer, {
      headers: { "content-type": "application/rss+xml" },
    });
    const normalized = await normalizeEncodedResponse(response);
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(await normalized.text()).toBe("<rss><channel /></rss>");
  });
});
