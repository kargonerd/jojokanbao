import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const token = "test-scheduler-secret-not-a-production-key";
let db: PGlite;
const migration = readFileSync(new URL("../../../infrastructure/supabase/migrations/202609060001_maintenance_scheduler_state.sql", import.meta.url), "utf8");
async function rpc(operation: string, owner: string | null = null, key: string | null = null, value: unknown = null, credential = token) {
  const result = await db.query<{ result: Record<string, unknown> }>(
    "select public.maintenance_scheduler_rpc($1,$2,$3,$4,$5::jsonb) as result",
    [credential, operation, owner, key, JSON.stringify(value)],
  );
  return result.rows[0]!.result;
}
const tick = () => ({ tick: new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString() });
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(migration);
  await db.query("insert into private.maintenance_scheduler_secret values (true, sha256(convert_to($1,'UTF8')))", [token]);
}, 30_000);
beforeEach(async () => {
  await db.exec("update private.maintenance_scheduler_control set backend='tencent', owner=null, lease_until=null, last_tick=null; truncate private.maintenance_scheduler_state;");
});
afterAll(async () => { await db.close(); });

describe("real Postgres scheduler state", () => {
  it("rejects a missing/wrong token and refuses browser table access", async () => {
    await expect(rpc("status", null, null, null, "wrong")).rejects.toThrow("Invalid scheduler credential");
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from private.maintenance_scheduler_secret")).rejects.toThrow(/permission denied/);
      expect(await rpc("status")).toHaveProperty("backend", "tencent");
    } finally { await db.exec("reset role"); }
  });
  it("has one owner and safely retries an ambiguous claim", async () => {
    const owner = randomUUID();
    expect(await rpc("claim", owner, null, tick())).toEqual({ claimed: true });
    expect(await rpc("claim", owner, null, tick())).toEqual({ claimed: true });
    expect(await rpc("claim", randomUUID(), null, tick())).toEqual({ claimed: false, reason: "busy" });
  });
  it("preserves arbitrary monitor cursors/failure state through a restart", async () => {
    const owner = randomUUID();
    await rpc("claim", owner, null, tick());
    const value = { cursor: 99, down: true, executionFailures: 2, pending: { signal: "fail" } };
    await rpc("put", owner, "monitor:rmrb-sync:monitor", value);
    expect(await rpc("get", owner, "monitor:rmrb-sync:monitor")).toEqual({ value });
    await rpc("release", owner);
    await expect(rpc("put", owner, "monitor:rmrb-sync:monitor", {})).rejects.toThrow("Scheduler lease lost");
    expect(await rpc("claim", randomUUID(), null, tick())).toHaveProperty("reason", "replayed");
  });
  it("fences expired owners and inactive backends", async () => {
    const owner = randomUUID();
    await rpc("claim", owner, null, tick());
    await db.exec("update private.maintenance_scheduler_control set lease_until=clock_timestamp()-interval '1 second'");
    await expect(rpc("put", owner, "dispatch:rmrb-sync", {})).rejects.toThrow("Scheduler lease lost");
    await db.exec("update private.maintenance_scheduler_control set backend='cloudflare'");
    expect(await rpc("claim", randomUUID(), null, tick())).toHaveProperty("reason", "inactive");
  });
  it("does not allow the runtime credential to activate itself or write arbitrary keys", async () => {
    const owner = randomUUID();
    await rpc("claim", owner, null, tick());
    await expect(rpc("put", owner, "control", { backend: "tencent" })).rejects.toThrow("Invalid state key");
    await expect(rpc("activate", owner, "dispatch:rmrb-sync", {})).rejects.toThrow("Invalid scheduler operation");
    await expect(rpc("put", owner, "dispatch:rmrb-sync", { data: "x".repeat(131073) })).rejects.toThrow("Invalid state value");
  });
  it("rejects stale/future events", async () => {
    for (const offset of [-180_000, 90_000]) {
      await expect(rpc("claim", randomUUID(), null, { tick: new Date(Date.now()+offset).toISOString() })).rejects.toThrow("Invalid tick");
    }
  });
  it("imports the exact CF state only before activation, without resetting down/cursors", async () => {
    await db.exec("update private.maintenance_scheduler_control set backend='cloudflare'");
    const snapshot = { states: { "monitor:times-capture:monitor": { cursor: 123, down: true, executionFailures: 2, seen: ["abc:1"] } } };
    expect(await rpc("import", null, null, snapshot)).toHaveProperty("importedAt");
    const rows = await db.query<{value:unknown}>("select value from private.maintenance_scheduler_state where key='monitor:times-capture:monitor'");
    expect(rows.rows[0]!.value).toEqual(snapshot.states["monitor:times-capture:monitor"]);
    await db.exec("update private.maintenance_scheduler_control set backend='tencent'");
    await expect(rpc("import", null, null, snapshot)).rejects.toThrow("Migration import is closed");
    await db.exec("update private.maintenance_scheduler_control set backend='cloudflare'");
    await expect(rpc("import", null, null, {states:{control:{backend:"tencent"}}})).rejects.toThrow("Invalid migration state");
  });
});
