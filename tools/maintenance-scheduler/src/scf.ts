import { randomUUID } from "node:crypto";
import { durableDispatch } from "./durable-dispatch";
import { handleScheduled } from "./index";
import { TaskMonitor } from "./monitor-object";
import { resolveScheduledSlot } from "./schedule";
import { SupabaseState, type StateEnv } from "./supabase-state";
import { SCHEDULED_TASKS, validateScheduledTasks } from "./tasks";
import type { SchedulerEnv } from "./types";

export interface ScfEnv extends SchedulerEnv, StateEnv { SCHEDULER_MODE: "shadow" | "active" }
export interface ScfEvent { Type?: string; Time?: string; TriggerName?: string; mode?: string }

export function loadScfEnv(values = process.env): ScfEnv {
  const required = ["GITHUB_TOKEN", "HEALTHCHECKS_API_KEY", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SCHEDULER_STATE_TOKEN"];
  for (const name of required) if (!values[name]?.trim()) throw new Error(`Missing ${name}`);
  if (!["shadow", "active"].includes(values.SCHEDULER_MODE ?? "shadow")) throw new Error("Invalid SCHEDULER_MODE");
  return {
    GITHUB_TOKEN: values.GITHUB_TOKEN!, HEALTHCHECKS_API_KEY: values.HEALTHCHECKS_API_KEY!,
    GITHUB_OWNER: values.GITHUB_OWNER ?? "kargonerd", GITHUB_REPO: values.GITHUB_REPO ?? "jojokanbao", GITHUB_REF: values.GITHUB_REF ?? "master",
    SUPABASE_URL: values.SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY: values.SUPABASE_PUBLISHABLE_KEY!,
    SCHEDULER_STATE_TOKEN: values.SCHEDULER_STATE_TOKEN!, SCHEDULER_MODE: (values.SCHEDULER_MODE ?? "shadow") as ScfEnv["SCHEDULER_MODE"],
  };
}

/** No HTTP entry point: only IAM-authorized Invoke and the native Timer. */
export async function handleScfEvent(event: ScfEvent, env: ScfEnv, now = Date.now()): Promise<unknown> {
  validateScheduledTasks();
  const state = new SupabaseState(env, randomUUID());
  if (event.mode === "probe") {
    const urls = [
      { name: "github", url: `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows?per_page=1`,
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "jojokanbao-maintenance-scheduler" } },
      { name: "healthchecks", url: "https://healthchecks.io/api/v3/checks/", headers: { "X-Api-Key": env.HEALTHCHECKS_API_KEY! } },
    ];
    const connectivity = await Promise.all(urls.map(async ({ name, url, headers }) => {
      const started = Date.now();
      const response = await fetch(url, { headers: headers as HeadersInit, redirect: "error", signal: AbortSignal.timeout(8000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`${name} probe: HTTP ${response.status}`);
      return { name, ok: true, milliseconds: Date.now() - started };
    }));
    return { mode: env.SCHEDULER_MODE, connectivity, state: await state.rpc("status") };
  }
  if (event.Type !== "Timer" || !event.Time) throw new Error("Only Timer events or read-only probes are supported");
  const scheduled = Date.parse(event.Time);
  if (!Number.isFinite(scheduled)) throw new Error("Invalid Timer time");
  if (now - scheduled > 120_000 || scheduled - now > 30_000) {
    console.log(JSON.stringify({ event: "maintenance_stale_tick", scheduledAt: event.Time }));
    return { skipped: "stale-tick" };
  }
  if (env.SCHEDULER_MODE === "shadow") {
    // Never claim production state, dispatch GitHub, provision checks, or ping.
    const due = SCHEDULED_TASKS.flatMap((task) => {
      const slot = resolveScheduledSlot(task, now);
      return slot ? [{ task: task.id, slot: slot.id }] : [];
    });
    console.log(JSON.stringify({ event: "maintenance_shadow_tick", observedAt: new Date(now).toISOString(), due }));
    return { mode: "shadow", due };
  }
  const claim = await state.claim(now);
  if (!claim.claimed) {
    console.log(JSON.stringify({ event: "maintenance_tick_skipped", reason: claim.reason }));
    return { skipped: claim.reason };
  }
  try {
    await handleScheduled({ scheduledTime: now, cron: "* * * * *" }, env, {
      schedulerDescription: "Tencent SCF one-minute scheduler and durable alert-policy consumer heartbeat.",
      dispatch: (task, taskEnv, options) => durableDispatch(state.store("dispatch"), task, taskEnv, options),
      monitor: async (tick) => {
        await new TaskMonitor({ storage: state.store(`monitor:${tick.slug}`) }, env).tick(tick);
      },
    });
    return { mode: "active", observedAt: new Date(now).toISOString() };
  } finally {
    await state.release();
  }
}
