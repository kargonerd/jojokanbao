import { describe, expect, it, vi } from "vitest";

import { pingHealthcheck, pingHealthcheckBestEffort } from "../src/healthchecks";

describe("pingHealthcheck", () => {
  it("posts a start signal with structured task metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));

    await pingHealthcheck("https://hc-ping.com/check-id?rid=run-id", "start", {
      fetcher,
      payload: { taskId: "rmrb-sync", failureType: "queue-late" },
    });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://hc-ping.com/check-id/start?rid=run-id");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      taskId: "rmrb-sync",
      failureType: "queue-late",
    });
  });

  it("rejects non-HTTPS ping URLs", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      pingHealthcheck("http://hc-ping.com/check-id", "success", { fetcher }),
    ).rejects.toThrow("Healthchecks ping URL must use HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps monitoring delivery failures best effort", async () => {
    const fetcher = vi.fn<typeof fetch>()
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
