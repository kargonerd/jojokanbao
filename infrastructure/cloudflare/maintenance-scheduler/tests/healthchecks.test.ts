import { describe, expect, it, vi } from "vitest";

import {
  ensureHealthcheck,
  pingHealthcheck,
  provisionHealthcheckBestEffort,
  reportHealthcheckBestEffort,
} from "../src/healthchecks";
import type { HealthcheckDefinition } from "../src/types";

const definition: HealthcheckDefinition = {
  name: "JOJO · rmrb-sync",
  slug: "rmrb-sync",
  schedule: "0 1 * * *",
  timeZone: "UTC",
  graceSeconds: 2700,
  tags: "jojo production maintenance rmrb",
  description: "Daily RMRB synchronization outcome.",
};

describe("ensureHealthcheck", () => {
  it("upserts a task check by slug from the task definition", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ping_url: "https://hc-ping.com/project-key/rmrb-sync" }),
    );

    await expect(ensureHealthcheck(definition, "management-api-key", { fetcher }))
      .resolves.toBe("https://hc-ping.com/project-key/rmrb-sync");

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://healthchecks.io/api/v3/checks/");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe("management-api-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "JOJO · rmrb-sync",
      slug: "rmrb-sync",
      tags: "jojo production maintenance rmrb",
      desc: "Daily RMRB synchronization outcome.",
      schedule: "0 1 * * *",
      tz: "UTC",
      grace: 2700,
      methods: "POST",
      channels: "*",
      unique: ["slug"],
    });
  });

  it("rejects a non-HTTPS ping URL returned by the API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ping_url: "http://hc-ping.com/project-key/rmrb-sync" }),
    );

    await expect(ensureHealthcheck(definition, "management-api-key", { fetcher }))
      .rejects.toThrow("Healthchecks ping URL must use HTTPS");
  });

  it("keeps provisioning failures best effort", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("unavailable", { status: 503 }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(provisionHealthcheckBestEffort(
      definition,
      "management-api-key",
      { fetcher },
    )).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("healthchecks_provision_failed"));

    error.mockRestore();
  });
});

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
      reportHealthcheckBestEffort(definition, "management-api-key", "fail", { fetcher }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Healthchecks check upsert failed with HTTP 503"),
    );

    error.mockRestore();
  });
});
