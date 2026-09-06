import { SCHEDULED_TASKS } from "./tasks";
import { taskStageHealthchecks, type SchedulerEnv } from "./types";

/** Internal-only snapshot transfer. No public route, no credential export. */
export async function exportMigrationState(env: SchedulerEnv): Promise<void> {
  if (!env.MONITORS || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SCHEDULER_STATE_TOKEN) {
    throw new Error("Migration state destination missing");
  }
  const endpoint = new URL(env.SUPABASE_URL);
  if (endpoint.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/u.test(endpoint.hostname)) throw new Error("Invalid migration destination");
  const states: Record<string, unknown> = {};
  const slugs = SCHEDULED_TASKS.flatMap((task) => [task.id, ...taskStageHealthchecks(task).map((check) => check.slug)]);
  await Promise.all(slugs.map(async (slug) => {
    const stub = env.MONITORS!.get(env.MONITORS!.idFromName(slug));
    const response = await stub.fetch("https://monitor.internal/snapshot");
    if (!response.ok) throw new Error(`Snapshot unavailable: ${slug}`);
    const snapshot = await response.json<{ monitor?: unknown; queue?: unknown }>();
    if (snapshot.monitor) states[`monitor:${slug}:monitor`] = snapshot.monitor;
    if (snapshot.queue) states[`monitor:${slug}:queue-monitor`] = snapshot.queue;
  }));
  const response = await fetch(`${endpoint.origin}/rest/v1/rpc/maintenance_scheduler_rpc`, {
    // workerd rejects redirect:"error"; manual also prevents credential forwarding.
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json", apikey: env.SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ p_token: env.SCHEDULER_STATE_TOKEN, p_operation: "import", p_value: { states } }),
  });
  if (!response.ok) throw new Error(`Migration import: HTTP ${response.status}`);
  console.log(JSON.stringify({ event: "maintenance_state_exported", keys: Object.keys(states) }));
}
