import { describe, expect, it, vi } from "vitest";

import { pingHealthcheck, pingHealthcheckBestEffort } from "../src/healthchecks";

describe("pingHealthcheck", () => {
  it("posts a start signal without exposing configuration in the payload", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));

    await pingHealthcheck("https://hc-ping.com/check-id?rid=run-id", "start", {
      fetcher,
      payload: { stage: "times-pipeline" },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://hc-ping.com/check-id/start?rid=run-id");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ stage: "times-pipeline" });
  });

  it("rejects non-HTTPS ping URLs", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      pingHealthcheck("http://hc-ping.com/check-id", "success", { fetcher }),
    ).rejects.toThrow("Healthchecks ping URL must use HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps monitoring delivery failures best effort", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      pingHealthcheckBestEffort("https://hc-ping.com/check-id", "fail", { fetcher }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Healthchecks fail ping failed with HTTP 503"),
    );

    error.mockRestore();
  });
});
