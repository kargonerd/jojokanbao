import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEncodedResponse, RecordingFetch } from "../src/recording-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JOJO_TIMES_PROXY_URI;
});

describe("recording fetch", () => {
  it("decompresses an upstream gzip body even when the encoding header is missing", async () => {
    const response = new Response(Uint8Array.from(gzipSync("<rss><channel /></rss>")).buffer, {
      headers: { "content-type": "application/rss+xml" },
    });
    const normalized = await normalizeEncodedResponse(response);
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(await normalized.text()).toBe("<rss><channel /></rss>");
  });

  it("tries discovery directly before retrying a blocked response through the configured proxy", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("blocked", { status: 400 }))
      .mockResolvedValueOnce(new Response("<rss />", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.JOJO_TIMES_PROXY_URI = "http://127.0.0.1:7890";
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-recording-fetch-"));
    const recorder = new RecordingFetch(output);
    const restore = recorder.install();
    try {
      const response = await fetch("https://publisher.test/feed.xml");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<rss />");
      await recorder.flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined();
      expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ dispatcher: expect.anything() }));
      expect(recorder.exchanges.map((exchange) => exchange.response?.status)).toEqual([400, 200]);
    } finally {
      restore();
      await rm(output, { recursive: true, force: true });
    }
  });
});
