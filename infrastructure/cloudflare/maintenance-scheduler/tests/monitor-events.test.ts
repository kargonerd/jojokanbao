import { describe, expect, it, vi } from "vitest";
import { checkUuid, listLoggedPings, parseExecution, readLoggedBody } from "../src/monitor-events";

const uuid = "11111111-1111-4111-8111-111111111111";
const received = Date.parse("2026-09-05T04:01:00Z");
const body = "monitor_event=v1\ntask=times-process\nrun_id=123\nrun_attempt=2\nevent_time=2026-09-05T04:00:00Z\noutcome=success\nfailure_class=unknown\nrun=https://github.com/kargonerd/jojokanbao/actions/runs/123";
describe("monitor event protocol", () => {
  it("parses a stable execution identity and the original completion time", () => {
    expect(parseExecution(body, "times-process", received)).toMatchObject({ id: "123:2", at: received - 60_000, outcome: "success" });
  });
  it.each([
    ["task=times-process", "task=times-capture"], ["run_attempt=2", "run_attempt="],
    ["outcome=success", "outcome=noop"], ["failure_class=unknown", "failure_class=oops"],
    ["T04:00:00Z", "T04:05:00Z"], ["/runs/123", "/runs/124"],
  ])("rejects malformed or cross-stage buffered events: %s", (from, to) => {
    expect(() => parseExecution(body.replace(from, to), "times-process", received)).toThrow("Invalid buffered");
  });
  it("ignores non-outcome logs and its own emitted decisions", () => {
    expect(parseExecution("task=times-process\nstatus=running", "times-process", received)).toBeUndefined();
    expect(parseExecution(JSON.stringify({ taskId: "times-process", status: "success" }), "times-process", received, true)).toBeUndefined();
  });
  it.each(["http://hc-ping.com/" + uuid, "https://attacker.example/" + uuid, "https://hc-ping.com/project/slug"])("rejects unsafe management identities %s", (url) => {
    expect(() => checkUuid(url)).toThrow("Invalid managed");
  });
  it("does not interpret a malformed successful API response as an empty inbox", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await expect(listLoggedPings(uuid, "key", fetcher)).rejects.toThrow("Invalid monitoring");
  });
  it("bounds body size and does not expose credentials to redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(8193)));
    await expect(readLoggedBody(uuid, 1, "key", fetcher)).rejects.toThrow("too large");
    expect(fetcher).toHaveBeenCalledWith(`https://healthchecks.io/api/v3/checks/${uuid}/pings/1/body`, expect.objectContaining({ redirect: "manual" }));
  });
  it("rejects redirects without forwarding the management key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }));
    await expect(readLoggedBody(uuid, 1, "key", fetcher)).rejects.toThrow("HTTP 302");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
