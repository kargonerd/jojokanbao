import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentUsageConfig, parseAgentUsageLimits } from "../src/edgeone/posthog";

const limits = { requestsPerMinute: 4, requestsPerDay: 150, maxRunSeconds: 240 };
const response = (payload: unknown) => ({ featureFlags: {ai_usage_limits_config:true}, featureFlagPayloads: {ai_usage_limits_config:payload} });
afterEach(() => vi.useRealTimers());
describe("PostHog server configuration", () => {
  it("deduplicates cold reads and keeps cached values while an asynchronous refresh is pending", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response(limits));
    const config = new AgentUsageConfig({getAllFlagsAndPayloads: fetch});
    expect(await Promise.all([config.get(),config.get()])).toEqual([limits,limits]);
    expect(fetch).toHaveBeenCalledTimes(1);
    let complete!: (value: unknown) => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    vi.advanceTimersByTime(300_001);
    expect(await config.get()).toEqual(limits);
    complete(response({...limits,requestsPerDay:200}));
    await vi.waitFor(async () => expect(await config.get()).toMatchObject({requestsPerDay:200}));
  });
  it("fails closed without a valid snapshot and preserves the last valid one on malformed/offline responses", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response({...limits,requestsPerMinute:0}));
    const config = new AgentUsageConfig({getAllFlagsAndPayloads: fetch});
    await expect(config.get()).rejects.toThrow("unavailable");
    fetch.mockResolvedValue(response(limits)); vi.advanceTimersByTime(30_001);
    expect(await config.get()).toEqual(limits);
    fetch.mockRejectedValue(new Error("offline")); vi.advanceTimersByTime(300_001);
    expect(await config.get()).toEqual(limits);
  });
  it.each([null,{}, {...limits,requestsPerMinute:"3"}, {...limits,requestsPerDay:0}, {...limits,maxRunSeconds:601}])("rejects malformed limits", value => {
    expect(parseAgentUsageLimits(value)).toBeUndefined();
  });
});
