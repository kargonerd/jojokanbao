// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostHog } from "posthog-js";
import { openBrowserConfigSession } from "../src/browser-config";
import type { ConfigSession } from "../src/config";

const sessions: Array<Pick<ConfigSession, "dispose">> = [];
let requests: Array<{ url: string; callback?: (response: { statusCode: number; json?: unknown }) => void }>;
beforeEach(() => {
  localStorage.clear();
  requests = [];
  // Exercise the installed SDK's actual persistence and response parsing without contacting PostHog.
  vi.spyOn(PostHog.prototype, "_send_request").mockImplementation((request) => { requests.push(request); });
});
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); vi.restoreAllMocks(); });

async function respond(session: Pick<ConfigSession, "refresh">, statusCode: number, json?: unknown) {
  requests.length = 0;
  session.refresh();
  await vi.waitFor(() => expect(requests.some((request) => request.url.includes("/flags/"))).toBe(true));
  requests.find((request) => request.url.includes("/flags/"))!.callback?.({ statusCode, json });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installed browser remote config SDK", () => {
  it("reads a guest JSON payload and restores it across restart without collecting events", async () => {
    const options = {token: "phc_config_test", key: "support_config"};
    localStorage.setItem("jojo.analytics.enabled.v1", "false");
    const session = await openBrowserConfigSession(options);
    sessions.push(session);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    await respond(session, 200, {errorsWhileComputingFlags: false, flags: {
      support_config: {key: "support_config", enabled: true, variant: null,
        metadata: {id: 10, version: 1, payload: '{"qqGroup":"123456789"}'}}
    }});
    expect(listener).toHaveBeenLastCalledWith({qqGroup: "123456789"});
    expect(requests.find(request => request.url.includes("/flags/"))).toMatchObject({
      data: {distinct_id: "jojo-public-config", person_properties: {signed_in: false}}
    });
    unsubscribe(); session.dispose();
    const restarted = await openBrowserConfigSession(options);
    sessions.push(restarted);
    expect(restarted.cached()).toEqual({qqGroup: "123456789"});
    const otherProject = await openBrowserConfigSession({ ...options, token: "phc_other_project" });
    sessions.push(otherProject);
    expect(otherProject.cached()).toBeUndefined();
    await respond(restarted, 0);
    expect(restarted.cached()).toEqual({qqGroup: "123456789"});
    expect(requests.every(request => request.url.includes("/flags/"))).toBe(true);
  });
  
  
});
