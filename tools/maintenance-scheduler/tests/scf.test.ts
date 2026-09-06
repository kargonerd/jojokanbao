import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScfEvent, loadScfEnv, type ScfEnv } from "../src/scf";
import { SupabaseState } from "../src/supabase-state";

const env: ScfEnv = { GITHUB_TOKEN: "github-test", HEALTHCHECKS_API_KEY: "hc-test", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master",
  SUPABASE_URL: "https://testref.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test", SCHEDULER_STATE_TOKEN: "s".repeat(40), SCHEDULER_MODE: "shadow" };
const now = Date.parse("2026-09-06T01:00:33Z");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("SCF entry", () => {
  it("shadow produces the same due slots with absolutely no HTTP calls", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await handleScfEvent({ Type: "Timer", Time: new Date(now).toISOString() }, env, now)).toEqual({ mode: "shadow", due: [
      { task: "times-capture", slot: "times-capture:2026-09-06T01:00:00.000Z" }, { task: "rmrb-sync", slot: "rmrb-sync:2026-09-06T01:00:00.000Z" },
    ] });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("drops old platform retries without business calls or synthetic heartbeats", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await handleScfEvent({ Type: "Timer", Time: new Date(now-180_000).toISOString() }, { ...env, SCHEDULER_MODE: "active" }, now)).toEqual({ skipped: "stale-tick" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("an inactive backend cannot dispatch or report a heartbeat", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ claimed: false, reason: "inactive" }));
    vi.stubGlobal("fetch", fetcher); vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await handleScfEvent({ Type: "Timer", Time: new Date(now).toISOString() }, { ...env, SCHEDULER_MODE: "active" }, now)).toEqual({ skipped: "inactive" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/rpc/maintenance_scheduler_rpc");
  });
  it("fails closed on malformed event/config", async () => {
    await expect(handleScfEvent({}, env, now)).rejects.toThrow("Only Timer");
    expect(() => loadScfEnv({})).toThrow("Missing GITHUB_TOKEN");
    expect(() => new SupabaseState({ ...env, SUPABASE_URL: "https://attacker.example" }, "test")).toThrow("Invalid scheduler state endpoint");
  });
});
