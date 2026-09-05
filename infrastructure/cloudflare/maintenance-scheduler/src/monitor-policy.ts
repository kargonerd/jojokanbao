import { Cron } from "croner";
import type { AlertPolicy, HealthcheckDefinition } from "./types";

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  executionFailures: 2,
  dispatchFailureSeconds: 5 * 60,
};

export interface ExecutionEvent {
  id: string;
  at: number;
  outcome: "success" | "failure";
  permanent: boolean;
  run: string;
}

export type DispatchObservation =
  | { kind: "failed"; permanent: boolean; reason: string }
  | { kind: "accepted" }
  | { kind: "exhausted" }
  | { kind: "idle" };

export interface MonitorState {
  version: 1;
  checkUuid: string;
  cursor: number;
  initialized: boolean;
  activated: boolean;
  deadlineAt: number;
  lastSuccessAt: number;
  executionFailures: number;
  lastExecutionAt: number;
  seen: string[];
  dispatchFailedAt?: number;
  dispatchReason?: string;
  dispatchPermanent?: boolean;
  lastDispatchAt: number;
  incidentAt?: number;
  down: boolean;
  pending?: { signal: "success" | "fail" | "start"; reason: string; at: number; run?: string };
}

export function nextDeadline(check: HealthcheckDefinition, successAt: number): number {
  const next = new Cron(check.schedule, { paused: true, timezone: check.timeZone }).nextRun(new Date(successAt));
  if (!next) throw new Error(`No next monitoring deadline for ${check.slug}`);
  return next.getTime() + check.graceSeconds * 1000;
}

export function initialState(check: HealthcheckDefinition, checkUuid: string, now: number): MonitorState {
  return { version: 1, checkUuid, cursor: 0, initialized: false, activated: false, deadlineAt: nextDeadline(check, now), lastSuccessAt: 0, executionFailures: 0, lastExecutionAt: 0, lastDispatchAt: 0, seen: [], down: false };
}

function markDown(state: MonitorState, reason: string, now: number, run?: string): void {
  if (state.down) return;
  state.down = true;
  state.activated = true;
  state.incidentAt = now;
  state.pending = { signal: "fail", reason, at: now, ...(run ? { run } : {}) };
}

export function markHistoryGap(state: MonitorState, now: number): void {
  if (state.down) return;
  markDown(state, "monitoring-history-gap", now);
  // A retained fresh success can reconcile lost history without postdating
  // this consumer's restart. An existing business incident keeps its boundary.
  state.incidentAt = state.lastExecutionAt;
}

export function observeExpectedSlot(state: MonitorState, check: HealthcheckDefinition, expectedAt: number, now: number): void {
  if (state.lastSuccessAt < expectedAt) state.deadlineAt = Math.min(state.deadlineAt, expectedAt + check.graceSeconds * 1000);
  // Arm a brand-new external check exactly once, even if its very first run
  // hangs. Normal dispatches/retries never send another /start.
  if (!state.activated && !state.pending) {
    state.activated = true;
    state.pending = { signal: "start", reason: "first-scheduled-slot", at: now };
  }
}

export function applyExecution(state: MonitorState, check: HealthcheckDefinition, policy: AlertPolicy, event: ExecutionEvent): void {
  if (state.seen.includes(event.id) || event.at < state.lastExecutionAt) return;
  state.seen = [...state.seen.slice(-255), event.id];
  state.lastExecutionAt = event.at;
  if (event.outcome === "success") {
    state.activated = true;
    state.lastSuccessAt = event.at;
    state.executionFailures = 0;
    state.deadlineAt = nextDeadline(check, event.at);
    if (state.dispatchFailedAt !== undefined && event.at >= state.dispatchFailedAt) {
      delete state.dispatchFailedAt;
      delete state.dispatchReason;
      delete state.dispatchPermanent;
    }
    if (state.down && state.incidentAt !== undefined && event.at < state.incidentAt) return;
    state.down = false;
    delete state.incidentAt;
    // Only a real, fresh execution outcome can advance the external heartbeat.
    state.pending = { signal: "success", reason: "execution-succeeded", at: event.at, run: event.run };
  } else {
    state.executionFailures += 1;
    if (event.permanent || state.executionFailures >= policy.executionFailures) {
      markDown(state, event.permanent ? "permanent-execution-failure" : "consecutive-execution-failures", event.at, event.run);
    }
  }
}

export function applyDispatch(state: MonitorState, observation: DispatchObservation, now: number): void {
  if (now < state.lastDispatchAt) return;
  state.lastDispatchAt = now;
  if (observation.kind === "failed") {
    state.dispatchFailedAt ??= now;
    state.dispatchReason = observation.reason;
    state.dispatchPermanent = observation.permanent;
    if (observation.permanent) markDown(state, "permanent-dispatch-failure", now);
  } else if (observation.kind === "accepted") {
    // Acceptance resolves a dispatch retry streak, not an execution incident.
    delete state.dispatchFailedAt;
    delete state.dispatchReason;
    delete state.dispatchPermanent;
  } else if (observation.kind === "exhausted") {
    markDown(state, "execution-attempts-exhausted", now);
  }
  // Neither a new schedule slot nor a retry advances deadlineAt.
}

export function evaluateDeadline(state: MonitorState, policy: AlertPolicy, now: number): void {
  if (now >= state.deadlineAt) markDown(state, "success-overdue", now);
  else if (state.dispatchFailedAt !== undefined && state.dispatchPermanent) markDown(state, "permanent-dispatch-failure", now);
  else if (state.dispatchFailedAt !== undefined && now - state.dispatchFailedAt >= policy.dispatchFailureSeconds * 1000) {
    markDown(state, "dispatch-failure-duration", now);
  }
}
