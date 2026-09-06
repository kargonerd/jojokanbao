import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercise precisely the workerd/Miniflare version bundled with pinned Wrangler.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const temporary = await mkdtemp(path.join(tmpdir(), "jojo-monitor-runtime-test-"));
const uuid = "11111111-1111-4111-8111-111111111111";
const start = Date.parse("2026-09-05T04:00:00Z");
const pings = [];
const bodies = new Map();
const signals = [];
const queueSignals = [];
let queued = 4;
function outcome(id, minute, signal) {
  const n = pings.length + 1;
  const date = new Date(start + minute * 60_000).toISOString();
  pings.push({ n, type: "log", date, body_url: `https://healthchecks.io/api/v3/checks/${uuid}/pings/${n}/body` });
  bodies.set(n, `monitor_event=v1\ntask=times-process\nrun_id=${id}\nrun_attempt=1\nevent_time=${date}\noutcome=${signal}\nfailure_class=unknown\nrun=https://github.com/kargonerd/jojokanbao/actions/runs/${id}`);
}
const options = () => convertV4MiniflareOptions({
  name: "monitor-runtime-test", modules: true, scriptPath: fileURLToPath(new URL("../node_modules/.cache/monitor-test/index.js", import.meta.url)),
  compatibilityDate: "2026-08-28", cf: false, telemetry: { enabled: false }, resourcePersistencePath: temporary,
  durableObjects: { MONITORS: { className: "MaintenanceMonitor", useSQLite: true } },
  bindings: { HEALTHCHECKS_API_KEY: "local-test-key", GITHUB_OWNER: "kargonerd", GITHUB_REPO: "jojokanbao", GITHUB_REF: "master", GITHUB_TOKEN: "local-test-token" },
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.origin === "https://api.github.com") {
      const runs = url.pathname.includes("maintenance-times-process.yml") && url.searchParams.get("status") === "pending"
        ? Array.from({ length: queued }, (_, id) => ({ id: id + 1, status: "pending", created_at: new Date(start).toISOString() })) : [];
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.origin === "https://healthchecks.io") {
      if (url.pathname === "/api/v3/checks/") return Response.json({ ping_url: `https://hc-ping.com/${uuid}` });
      if (url.pathname.endsWith("/pings/")) return Response.json({ pings: [...pings].reverse() });
      if (url.pathname.endsWith("/body")) return new Response(bodies.get(Number(url.pathname.split("/").at(-2))));
    }
    if (url.origin === "https://hc-ping.com") {
      const body = await request.json();
      if (body.taskId === "times-process-queue") {
        queueSignals.push(url.pathname.endsWith("/fail") ? "fail" : url.pathname.endsWith("/start") ? "start" : "success");
        return new Response("OK");
      }
      signals.push(url.pathname.endsWith("/fail") ? "fail" : "success");
      return new Response("OK");
    }
    throw new Error(`Unexpected network access in isolated runtime test: ${url.origin}`);
  },
});
let mf;
async function tick(minute, slug = "times-process") {
  const namespace = await mf.getDurableObjectNamespace("MONITORS");
  const stub = namespace.get(namespace.idFromName(slug));
  const response = await stub.fetch("https://monitor.internal/tick", { method: "POST", body: JSON.stringify({ slug, now: start + minute * 60_000 }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
try {
  mf = new Miniflare(options());
  outcome(1, 1, "failure");
  assert.equal((await tick(2)).down, false);
  assert.deepEqual(signals, []);
  await tick(2, "times-process-queue");
  assert.deepEqual(queueSignals, ["start"]);
  await mf.dispose();
  mf = new Miniflare(options());
  // The second failure must count after a complete runtime restart (SQLite).
  outcome(2, 3, "failure");
  assert.equal((await tick(4)).down, true);
  await tick(5);
  assert.deepEqual(signals, ["fail"]);
  outcome(3, 6, "success");
  assert.equal((await tick(7)).down, false);
  await tick(8);
  assert.deepEqual(signals, ["fail", "success"]);
  assert.equal((await tick(8, "times-process-queue")).down, true);
  assert.deepEqual(queueSignals, ["start", "fail"]);
  queued = 0;
  assert.equal((await tick(9, "times-process-queue")).down, false);
  assert.deepEqual(queueSignals, ["start", "fail", "success"]);
  console.log("SQLite/workerd monitoring restart, deduplication and recovery smoke passed.");
} finally {
  await mf?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
