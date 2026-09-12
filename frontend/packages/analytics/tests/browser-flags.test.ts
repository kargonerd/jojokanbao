// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostHog } from "posthog-js";
import { openBrowserFlagSession } from "../src/browser-flags";
import type { FlagSession } from "../src/flags";

const sessions: FlagSession[] = [];
let requests: Array<{ url: string; callback?: (response: { statusCode: number; json?: unknown }) => void }>;
beforeEach(() => {
  localStorage.clear();
  requests = [];
  // Exercise the installed SDK's actual persistence and response parsing without contacting PostHog.
  vi.spyOn(PostHog.prototype, "_send_request").mockImplementation((request) => { requests.push(request); });
});
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); vi.restoreAllMocks(); });

async function open(userId = "reader-a", token = "phc_flags_test") {
  const session = await openBrowserFlagSession({ token, host: "https://us.i.posthog.com", userId });
  sessions.push(session);
  return session;
}
async function respond(session: FlagSession, statusCode: number, json?: unknown) {
  requests.length = 0;
  session.refresh();
  await vi.waitFor(() => expect(requests.some((request) => request.url.includes("/flags/"))).toBe(true));
  requests.find((request) => request.url.includes("/flags/"))!.callback?.({ statusCode, json });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installed browser flag SDK", () => {
  it("persists across restart, survives offline and isolates accounts and projects even with analytics opted out", async () => {
    localStorage.setItem("jojo.analytics.enabled.v1", "false");
    localStorage.setItem("__ph_opt_in_out_phc_flags_test", "0");
    const first = await open();
    await respond(first, 200, { errorsWhileComputingFlags: false, flags: {
      reader_speech: { key: "reader_speech", enabled: true, variant: null,
        reason: { code: "condition_match", condition_index: 0, description: "Matched condition set 1" },
        metadata: { id: 3, version: 1, payload: null } },
    } });
    expect(requests.find((request) => request.url.includes("/flags/"))).toMatchObject({
      data: { distinct_id: "reader-a", person_properties: { signed_in: true, account_id: "reader-a" } },
    });
    expect(first.cached()["reader.speech"]).toBe(true);
    first.dispose();
    const restarted = await open();
    expect(restarted.cached()["reader.speech"]).toBe(true);
    await respond(restarted, 0);
    expect(restarted.cached()["reader.speech"]).toBe(true);
    expect((await open("reader-b")).cached()["reader.speech"]).toBe(false);
    expect((await open("reader-a", "phc_other_project")).cached()["reader.speech"]).toBe(false);
    expect(requests.every((request) => !request.url.includes("/e/") && !request.url.includes("/i/v0/e/"))).toBe(true);
  });
  it("publishes false and removed flags instead of reviving an old true value", async () => {
    const session = await open();
    const listener = vi.fn();
    const stop = session.subscribe(listener);
    await respond(session, 200, { featureFlags: { "reader_speech": true, "library_bookshelf": true } });
    await respond(session, 200, { featureFlags: { "reader_speech": false } });
    expect(listener).toHaveBeenLastCalledWith({ "reader.speech": false, "library.bookshelf": false, "reader.annotations": false });
    stop();
  });
});
