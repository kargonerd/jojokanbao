import { ensureHealthcheck, pingHealthcheck } from "./healthchecks";
import { checkUuid, listLoggedPings, parseExecution, readLoggedBody } from "./monitor-events";
import { applyDispatch, applyExecution, DEFAULT_ALERT_POLICY, evaluateDeadline, initialState, markHistoryGap, nextDeadline, observeExpectedSlot, type DispatchObservation, type MonitorState } from "./monitor-policy";
import { SCHEDULED_TASKS } from "./tasks";
import { taskHealthcheck, taskStageHealthchecks, type AlertPolicy, type HealthcheckDefinition, type ScheduledTask, type SchedulerEnv } from "./types";

export interface MonitorTick {
  slug: string;
  now: number;
  dispatch?: DispatchObservation;
  bodyBudget?: number;
  expectedAt?: number;
}

export function configuredMonitor(slug: string): { check: HealthcheckDefinition; policy: AlertPolicy } {
  for (const task of SCHEDULED_TASKS as readonly ScheduledTask[]) {
    if (task.id === slug) return { check: taskHealthcheck(task), policy: { ...DEFAULT_ALERT_POLICY, ...task.monitoring.alertPolicy } };
    const stage = task.monitoring.stages?.find((candidate) => candidate.slug === slug);
    if (stage) return { check: taskStageHealthchecks(task).find((check) => check.slug === slug)!, policy: { ...DEFAULT_ALERT_POLICY, ...stage.alertPolicy } };
  }
  throw new Error(`Unknown monitor: ${slug}`);
}

/** One internal actor per stage. No public HTTP endpoint or additional secret. */
export class MaintenanceMonitor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: DurableObjectState, private readonly env: SchedulerEnv) {}

  fetch(request: Request): Promise<Response> {
    // Serialize read/decide/deliver including awaits. Commit durable state before
    // external delivery; retries replay a signal without incrementing counters.
    const operation = this.queue.then(async () => {
      const tick = await request.json<MonitorTick>();
      if (!Number.isFinite(tick.now) || !tick.slug) return new Response("Invalid monitor tick", { status: 400 });
      return Response.json(await this.tick(tick));
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async tick(tick: MonitorTick): Promise<{ cursor: number; down: boolean }> {
    const { check, policy } = configuredMonitor(tick.slug);
    const key = this.env.HEALTHCHECKS_API_KEY;
    if (!key) throw new Error("Monitoring management key is missing");
    const pingUrl = await ensureHealthcheck(check, key);
    const uuid = checkUuid(pingUrl);
    const previous = await this.context.storage.get<MonitorState>("monitor");
    const state = previous?.checkUuid === uuid ? structuredClone(previous) : initialState(check, uuid, tick.now);
    const pings = await listLoggedPings(uuid, key);
    if (!state.initialized) {
      // Preserve the pre-migration heartbeat without inventing a success.
      const success = pings.filter((ping) => ping.type === "success").at(-1);
      if (success) {
        state.lastSuccessAt = Date.parse(success.date);
        state.deadlineAt = nextDeadline(check, state.lastSuccessAt);
      }
      state.activated = pings.some((ping) => ["success", "start", "fail"].includes(ping.type));
      state.initialized = true;
    } else if ((pings[0]?.n ?? 0) > state.cursor + 1 || (pings.at(-1)?.n ?? 0) < state.cursor) {
      // History loss is not success. Resume from retained events so a later
      // genuine success can recover without an operator resetting the actor.
      markHistoryGap(state, tick.now);
      state.cursor = (pings[0]?.n ?? 1) - 1;
      console.error(JSON.stringify({ event: "monitoring_history_gap", taskId: check.slug }));
    }

    const unseen = pings.filter((ping) => ping.n > state.cursor);
    const budget = Math.max(1, Math.min(8, tick.bodyBudget ?? 8));
    const selected: typeof unseen = [];
    let bodies = 0;
    for (const ping of unseen) {
      if (["log", "success"].includes(ping.type) && ping.body_url) {
        if (bodies >= budget) break;
        bodies += 1;
      }
      selected.push(ping);
    }
    // A body download failure must not advance the cursor past an outcome.
    const events = await Promise.all(selected.map(async (ping) => ({
      ping,
      event: ["log", "success"].includes(ping.type) && ping.body_url
        ? parseExecution(await readLoggedBody(uuid, ping.n, key), check.slug, Date.parse(ping.date), ping.type === "success")
        : undefined,
    })));
    for (const { ping, event } of events) {
      if (event) {
        applyExecution(state, check, policy, event);
        // Legacy success already reached Healthchecks; do not echo it.
        if (event.id.startsWith("legacy:") && state.pending?.at === event.at && state.pending.signal === "success") delete state.pending;
      }
      state.cursor = ping.n;
    }

    if (tick.expectedAt !== undefined) observeExpectedSlot(state, check, tick.expectedAt, tick.now);
    if (tick.dispatch) applyDispatch(state, tick.dispatch, tick.now);
    // Catch up before emitting transitions: a buffered success may have already
    // resolved an earlier failure while this monitor was unavailable.
    if (selected.length < unseen.length) {
      await this.context.storage.put("monitor", state);
      return { cursor: state.cursor, down: state.down };
    }
    evaluateDeadline(state, policy, tick.now);
    await this.context.storage.put("monitor", state);
    if (state.pending) {
      const pending = state.pending;
      await pingHealthcheck(pingUrl, pending.signal, { payload: {
        taskId: check.slug, stage: check.slug, status: pending.signal === "start" ? "started" : pending.signal === "success" ? "success" : "failed",
        failureType: pending.signal === "fail" ? pending.reason : "", observedAt: new Date(pending.at).toISOString(),
        executionFailures: state.executionFailures, ...(pending.run ? { run: pending.run } : {}),
      } });
      delete state.pending;
      await this.context.storage.put("monitor", state);
    }
    console.log(JSON.stringify({ event: "maintenance_monitor_tick", taskId: check.slug, cursor: state.cursor, down: state.down, executionFailures: state.executionFailures }));
    return { cursor: state.cursor, down: state.down };
  }
}

export async function tickMonitor(env: SchedulerEnv, tick: MonitorTick): Promise<void> {
  if (!env.MONITORS) throw new Error("MONITORS durable binding is missing");
  const stub = env.MONITORS.get(env.MONITORS.idFromName(tick.slug));
  const response = await stub.fetch("https://monitor.internal/tick", {
    method: "POST", body: JSON.stringify(tick), headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`Monitor tick failed for ${tick.slug}: HTTP ${response.status}`);
}
