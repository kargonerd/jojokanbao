import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { collectEgressDiagnostics } from "../src/edgeone/egress";
import { createEdgeOneAgentHandler } from "../src/edgeone/handler";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const reply = async (input: string | URL | Request) => String(input).includes("ipify")
  ? Response.json({ ip: "2001:db8::1", token: "never-log-this" })
  : new Response("ip=192.0.2.1\nloc=SG\ncolo=NRT\nuag=never-log-this\n");

describe("Agent egress diagnostics", () => {
  it("queries only fixed destinations without credentials and keeps only validated fields", async () => {
    const fetcher = vi.fn(reply);
    const first = await collectEgressDiagnostics(undefined, fetcher);
    const second = await collectEgressDiagnostics(undefined, fetcher);
    expect(first.observations).toEqual([
      { source: "ipify", status: "ok", ip: "2001:db8::1", family: 6 },
      { source: "cloudflare", status: "ok", ip: "192.0.2.1", family: 4, country: "SG" },
    ]);
    expect(first.processId).toBe(second.processId);
    expect(JSON.stringify(first)).not.toMatch(/never-log|NRT/);
    for (const [url, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(["https://api64.ipify.org?format=json", "https://www.cloudflare.com/cdn-cgi/trace"]).toContain(url);
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it("bounds concurrent requests even when fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = collectEgressDiagnostics(undefined, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).observations.map(item => item.status)).toEqual(["timeout", "timeout"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled response bodies and cancels with the model request", async () => {
    vi.useFakeTimers();
    const pending = collectEgressDiagnostics(undefined, async () => new Response(new ReadableStream()));
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).observations.map(item => item.status)).toEqual(["timeout", "timeout"]);
    const cancellation = new AbortController();
    cancellation.abort();
    const fetcher = vi.fn(reply);
    expect((await collectEgressDiagnostics(cancellation.signal, fetcher)).observations
      .map(item => item.status)).toEqual(["aborted", "aborted"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retain errors, oversized bodies, or invalid IP addresses", async () => {
    const oversized = await collectEgressDiagnostics(undefined, async () => new Response("x".repeat(4_097)));
    expect(oversized.observations.every(item => item.status === "invalid_response")).toBe(true);
    const invalid = await collectEgressDiagnostics(undefined, async () => new Response("ip=secret\nloc=secret\n"));
    expect(invalid.observations.every(item => item.status === "invalid_response")).toBe(true);
    const failure = await collectEgressDiagnostics(undefined, async () => { throw new Error("secret"); });
    expect(failure.observations.every(item => item.status === "network_error")).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
});

describe("monitor diagnostics in the real Agent handler", () => {
  function handler(monitor: boolean, failModel = false) {
    const faux = fauxProvider({ provider: "openai-codex", tokensPerSecond: 100_000 });
    faux.setResponses([failModel
      ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "User location is not supported for the API use." })
      : fauxAssistantMessage("OK")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    return createEdgeOneAgentHandler({
      authorize: async () => ({ id: "user", ...(monitor ? { isAvailabilityMonitor: true } : {}) }),
      acquireUsage: async () => ({ maxRunSeconds: 300, release: async () => {} }),
      createModelRuntime: async () => ({
        config: { provider: "openai-codex", model: model.id }, models, model, configured: true,
      }),
    });
  }

  it("does no network probing for an ordinary user, even with a monitor conversation prefix", async () => {
    const fetcher = vi.fn(reply);
    vi.stubGlobal("fetch", fetcher);
    const response = await handler(false)({
      conversation_id: "jojo-ai-health-forged", request: { body: { message: "OK", diagnostics: true } },
    });
    const body = await response.text();
    expect(body).toContain('"stopReason":"stop"');
    expect(body).not.toContain("event: diagnostics");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains diagnostics and the model outcome when failModel=%s", async (failModel) => {
    vi.stubGlobal("fetch", vi.fn(reply));
    const attributes = vi.fn();
    const response = await handler(true, failModel)({
      conversation_id: "jojo-ai-health-test", request: { body: { message: "OK" } },
      tracer: { span: async (_name, callback) => callback({ setAttributes: attributes }) },
    });
    const body = await response.text();
    expect(body).toContain("event: diagnostics");
    expect(body).toContain('"country":"SG"');
    expect(attributes).toHaveBeenCalledWith(expect.objectContaining({ "agent.egress.cloudflare.ip": "192.0.2.1" }));
    if (failModel) expect(body).toContain("User location is not supported");
    else expect(body).toContain('"stopReason":"stop"');
  });

  it("keeps successful model output when both diagnostic lookups fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network secret"); }));
    const response = await handler(true)({ request: { body: { message: "OK" } } });
    const body = await response.text();
    expect(body).toContain('"stopReason":"stop"');
    expect(body).toContain('"status":"network_error"');
    expect(body).not.toContain("network secret");
  });
});
