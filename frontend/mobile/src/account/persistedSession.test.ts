import { describe, expect, it, vi } from "vitest";
import { MOBILE_AUTH_STORAGE_KEY, readMobilePersistedSession } from "./persistedSession";

describe("native persisted auth identity", () => {
  it("reads the SDK's existing session even when the access token is expired", async () => {
    const session = { user: { id: "reader" }, access_token: "expired", refresh_token: "refresh", expires_at: 1 };
    const storage = { getItem: vi.fn().mockResolvedValue(JSON.stringify(session)) };
    expect(await readMobilePersistedSession(storage)).toEqual(session);
    expect(storage.getItem).toHaveBeenCalledWith(MOBILE_AUTH_STORAGE_KEY);
  });
  it.each([null, "invalid json", "null", "[]", "{}", '{"user":{"id":"reader"}}'])("ignores missing or malformed storage: %s", async (value) => {
    expect(await readMobilePersistedSession({ getItem: async () => value })).toBeNull();
  });
  it("allows startup when storage is unavailable", async () => {
    expect(await readMobilePersistedSession({ getItem: async () => { throw new Error("unavailable"); } })).toBeNull();
  });
});
