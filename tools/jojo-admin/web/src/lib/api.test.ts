import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("admin API client", () => {
  it("returns a successful JSON payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, publications: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(apiGet("/api/publications")).resolves.toEqual({
      success: true,
      publications: [],
    });
  });

  it("surfaces backend operation errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, message: "索引不可写" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(apiPost("/api/es-repair/apply", {})).rejects.toThrow(
      "索引不可写",
    );
  });
});
