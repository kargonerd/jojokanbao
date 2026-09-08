import { EMAIL_BODY_LIMIT, parseEmailObservation } from "./email-events";
import { applyEmailDispatch, applyEmailObservation, evaluateEmailState, initialEmailState, type EmailMonitorState } from "./email-policy";
import { pingHealthcheck } from "./healthchecks";
import { listLoggedPings, readLoggedBody } from "./monitor-events";
import type { MonitorTick } from "./monitor-object";
import type { HealthcheckDefinition, StateStore } from "./types";

/** SCF's existing lease remains the only writer of provider-event state. */
export async function tickEmailMonitor(storage: StateStore, check: HealthcheckDefinition, apiKey: string, pingUrl: string, uuid: string, tick: MonitorTick): Promise<{ cursor: number; down: boolean }> {
  const previous = await storage.get<EmailMonitorState>("monitor");
  const state = previous?.checkUuid === uuid && previous.kind === "email-delivery" ? structuredClone(previous) : initialEmailState(check, uuid, tick.now);
  const pings = await listLoggedPings(uuid, apiKey);
  if (state.cursor > 0 && ((pings[0]?.n ?? 0) > state.cursor + 1 || (pings.at(-1)?.n ?? 0) < state.cursor)) {
    // A missed transport failure cannot be disproved by an empty later scan.
    state.transport.incident = { at: state.lastObservationAt, reason: "email_monitoring_history_gap" };
    state.cursor = (pings[0]?.n ?? 1) - 1;
  }
  const unseen = pings.filter((ping) => ping.n > state.cursor);
  const selected: typeof unseen = [];
  let bodies = 0;
  const budget = Math.max(1, Math.min(8, tick.bodyBudget ?? 8));
  for (const ping of unseen) {
    if (ping.type === "log") {
      if (bodies >= budget) break;
      bodies += 1;
    }
    selected.push(ping);
  }
  // Validate the entire selected batch before committing any cursor advance.
  const observations = await Promise.all(selected.map(async (ping) => {
    if (ping.type !== "log") return { ping };
    if (!ping.body_url) throw new Error("Email monitoring observation body is missing");
    const body = await readLoggedBody(uuid, ping.n, apiKey, fetch, EMAIL_BODY_LIMIT);
    return { ping, observation: parseEmailObservation(body, Date.parse(ping.date)) };
  }));
  for (const { ping, observation } of observations) {
    if (observation) applyEmailObservation(state, check, observation);
    state.cursor = ping.n;
  }
  if (tick.expectedAt !== undefined && state.lastObservationAt < tick.expectedAt) state.deadlineAt = Math.min(state.deadlineAt, tick.expectedAt + check.graceSeconds * 1000);
  if (tick.dispatch) applyEmailDispatch(state, tick.dispatch, tick.now);
  if (selected.length < unseen.length) {
    await storage.put("monitor", state);
    return { cursor: state.cursor, down: state.down };
  }
  evaluateEmailState(state, tick.now);
  await storage.put("monitor", state);
  if (state.pending) {
    const pending = state.pending;
    await pingHealthcheck(pingUrl, pending.signal, { payload: {
      taskId: check.slug, stage: check.slug, status: state.status, failureType: pending.signal === "fail" ? pending.reason : "",
      observedAt: new Date(pending.at).toISOString(), collector: state.collector.incident ? "down" : state.collector.lastSuccessAt ? "up" : "unknown",
      transport: state.transport.incident ? "down" : state.transport.lastSuccessAt ? "verified" : "unknown",
      delivery: state.delivery.incident ? "down" : state.delivery.lastSuccessAt ? "verified" : "unknown",
      ...(pending.run ? { run: pending.run } : {}),
    } });
    delete state.pending;
    await storage.put("monitor", state);
  }
  console.log(JSON.stringify({ event: "maintenance_email_monitor_tick", taskId: check.slug, cursor: state.cursor, down: state.down,
    status: state.status, collectorHealthy: !state.collector.incident && state.collector.lastSuccessAt > 0,
    transportVerifiedAt: state.transport.lastSuccessAt || null, trackedMessages: state.messages.length }));
  return { cursor: state.cursor, down: state.down };
}
