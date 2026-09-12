import { EMAIL_MESSAGE_LIMIT, type EmailObservation, type EmailStatus } from "./email-events";
import { nextDeadline, type DispatchObservation } from "./monitor-policy";
import type { HealthcheckDefinition } from "./types";

export const EMAIL_POLICY = { delayedSeconds: 600, failureWindowSeconds: 1800, failureThreshold: 3, transportMaxAgeSeconds: 4 * 3600 + 1800, dispatchFailureSeconds: 300 };
export interface EmailIncident { at: number; reason: string }
export interface StoredEmail { id: string; createdAt: number; status: EmailStatus; statuses: EmailStatus[]; observedAt: number; delayAlerted: boolean; confirmedDelivery: boolean }
export interface EmailMonitorState {
  version: 1;
  kind: "email-delivery";
  checkUuid: string;
  cursor: number;
  createdAt: number;
  lastObservationAt: number;
  deadlineAt: number;
  seen: string[];
  messages: StoredEmail[];
  collector: { lastSuccessAt: number; incident?: EmailIncident };
  transport: { lastSuccessAt: number; seen: string[]; incident?: EmailIncident };
  delivery: { lastSuccessAt: number; incident?: EmailIncident };
  dispatch: { at: number; expectedAt?: number; failure?: EmailIncident; permanent?: boolean };
  down: boolean;
  status: "unknown" | "up" | "down";
  pending?: { signal: "success" | "fail"; reason: string; at: number; run?: string };
}
const delivered = (status: EmailStatus) => ["delivered", "opened", "clicked"].includes(status);
const waiting = (status: EmailStatus) => ["queued", "scheduled", "sent", "delivery_delayed"].includes(status);
const terminalFailure = (status: EmailStatus) => ["failed", "suppressed", "canceled", "complained", "bounced"].includes(status);
const unresolvedDelay = (message: StoredEmail) => message.delayAlerted && (waiting(message.status) || (delivered(message.status) && !message.confirmedDelivery));

/** One provider message is one anomaly, even across retries or status changes. */
export function countEmailAnomalies(state: EmailMonitorState, now: number): number {
  return state.messages.filter((message) => unresolvedDelay(message)
    || (message.createdAt >= now - EMAIL_POLICY.failureWindowSeconds * 1000
      && terminalFailure(message.status))).length;
}

export function initialEmailState(check: HealthcheckDefinition, checkUuid: string, now: number): EmailMonitorState {
  return { version: 1, kind: "email-delivery", checkUuid, cursor: 0, createdAt: now, lastObservationAt: 0,
    deadlineAt: nextDeadline(check, now), seen: [], messages: [], collector: { lastSuccessAt: 0 }, transport: { lastSuccessAt: 0, seen: [] },
    delivery: { lastSuccessAt: 0 }, dispatch: { at: 0 }, down: false, status: "unknown" };
}

export function applyEmailObservation(state: EmailMonitorState, check: HealthcheckDefinition, observation: EmailObservation): void {
  const runId = `${observation.runId}:${observation.runAttempt}`;
  const at = Date.parse(observation.eventTime);
  if (state.seen.includes(runId) || at < state.lastObservationAt) return;
  state.seen = [...state.seen.slice(-255), runId];
  state.lastObservationAt = at;
  state.deadlineAt = nextDeadline(check, at);
  // An observation for the affected slot proves dispatch reached its consumer,
  // even if it arrives after a later reconciliation error. Older slots cannot
  // clear a newer slot's fault. Legacy state falls back to the error timestamp.
  if (state.dispatch.failure && at >= (state.dispatch.expectedAt ?? state.dispatch.failure.at)) {
    delete state.dispatch.failure;
    delete state.dispatch.permanent;
    delete state.dispatch.expectedAt;
  }
  if (!observation.scanComplete) {
    state.collector.incident = { at, reason: observation.scanError! };
  }
  {
    const probeId = "messageId" in observation.transportProbe ? observation.transportProbe.messageId : undefined;
    const synthetic = new Set([...state.transport.seen, ...(probeId ? [probeId] : [])]);
    const observedMessages = observation.messages.filter((message) => !synthetic.has(message.id));
    // Keep unresolved delayed messages even after they leave the API window:
    // disappearance is not proof of delivery or resolution.
    const retained = state.messages.filter((message) => !synthetic.has(message.id)
      && (!observation.scanComplete || message.createdAt >= Date.parse(observation.scanStart) || unresolvedDelay(message)));
    const previous = new Map(retained.map((message) => [message.id, message]));
    const union = new Set([...previous.keys(), ...observedMessages.map((message) => message.id)]);
    if (union.size > EMAIL_MESSAGE_LIMIT) {
      state.collector.incident = { at, reason: "email_state_capacity" };
    } else {
      if (observation.scanComplete) {
        delete state.collector.incident;
        state.collector.lastSuccessAt = at;
      }
      for (const observed of observedMessages) {
        const old = previous.get(observed.id);
        const createdAt = Date.parse(observed.createdAt);
        const evidenceIsNew = delivered(observed.status) && !old?.confirmedDelivery;
        if (observation.scanComplete && evidenceIsNew) state.delivery.lastSuccessAt = at;
        // Provider snapshots may lag; an old sent state cannot undo an already
        // confirmed delivery and invent a new delayed-delivery incident.
        const preservePrevious = old && ((old.confirmedDelivery && waiting(observed.status))
          || (terminalFailure(old.status) && (waiting(observed.status) || (!observation.scanComplete && delivered(observed.status)))));
        const status = preservePrevious ? old.status : observed.status;
        const stored: StoredEmail = { id: observed.id, createdAt, status,
          statuses: [...new Set([...(old?.statuses ?? []), observed.status])], observedAt: at, delayAlerted: old?.delayAlerted ?? false,
          confirmedDelivery: old?.confirmedDelivery || (observation.scanComplete && delivered(observed.status)) };
        if (waiting(status) && !stored.delayAlerted && at - createdAt > EMAIL_POLICY.delayedSeconds * 1000) {
          stored.delayAlerted = true;
        }
        previous.set(observed.id, stored);
      }
      state.messages = [...previous.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      if (countEmailAnomalies(state, at) >= EMAIL_POLICY.failureThreshold) {
        state.delivery.incident ??= { at, reason: "email_failure_threshold" };
        state.delivery.incident.reason = "email_failure_threshold";
      } else if (observation.scanComplete) {
        // Re-evaluate legacy single-message incidents under the new policy only
        // on a complete observation. Keep individual message evidence intact.
        delete state.delivery.incident;
      }
    }
  }

  const probe = observation.transportProbe;
  if (probe.outcome === "failure") {
    const probeAt = Date.parse(probe.at);
    if (probeAt >= state.transport.lastSuccessAt && (!state.transport.incident || probeAt >= state.transport.incident.at)) state.transport.incident = { at: probeAt, reason: probe.reason };
  } else if (probe.outcome === "success" && !state.transport.seen.includes(probe.messageId)) {
    const probeAt = Date.parse(probe.at);
    state.transport.seen = [...state.transport.seen.slice(-63), probe.messageId];
    if (probeAt > state.transport.lastSuccessAt) {
      state.transport.lastSuccessAt = probeAt;
      if (!state.transport.incident || probeAt > state.transport.incident.at) {
        delete state.transport.incident;
      }
    }
  }
  evaluateEmailState(state, at, observation.scanComplete && !state.collector.incident, observation.run);
}

export function applyEmailDispatch(state: EmailMonitorState, dispatch: DispatchObservation, now: number, expectedAt?: number): void {
  if (now < state.dispatch.at) return;
  state.dispatch.at = now;
  // A state/API read can fail while reconciling an already observed slot.
  // That does not invalidate its collector, delivery or SMTP evidence.
  if (expectedAt !== undefined && state.lastObservationAt >= expectedAt) return;
  if (dispatch.kind === "failed" || dispatch.kind === "exhausted") {
    if (expectedAt !== undefined) state.dispatch.expectedAt = expectedAt;
    else delete state.dispatch.expectedAt;
  }
  if (dispatch.kind === "failed") {
    state.dispatch.failure ??= { at: now, reason: "email_dispatch_failed" };
    state.dispatch.permanent = dispatch.permanent;
  } else if (dispatch.kind === "exhausted") {
    state.dispatch.failure = { at: now, reason: "email_dispatch_exhausted" };
    state.dispatch.permanent = true;
  } else if (dispatch.kind === "accepted") {
    delete state.dispatch.failure;
    delete state.dispatch.permanent;
    delete state.dispatch.expectedAt;
  }
}

export function evaluateEmailState(state: EmailMonitorState, now: number, heartbeat = false, run?: string): void {
  const dispatchFailure = state.dispatch.failure && (state.dispatch.permanent || now - state.dispatch.failure.at >= EMAIL_POLICY.dispatchFailureSeconds * 1000) ? state.dispatch.failure : undefined;
  const missingObservation = now >= state.deadlineAt ? { at: now, reason: "email_observation_overdue" } : undefined;
  const missingTransport = now - (state.transport.lastSuccessAt || state.createdAt) >= EMAIL_POLICY.transportMaxAgeSeconds * 1000 ? { at: now, reason: "email_transport_overdue" } : undefined;
  const failure = state.transport.incident ?? state.delivery.incident ?? state.collector.incident ?? dispatchFailure ?? missingObservation ?? missingTransport;
  if (failure) {
    if (!state.down || state.pending) state.pending = { signal: "fail", reason: failure.reason, at: failure.at, ...(run ? { run } : {}) };
    state.down = true;
    state.status = "down";
  } else if (state.transport.lastSuccessAt > 0) {
    if (heartbeat) state.down = false;
    state.status = state.down ? "down" : "up";
    if (heartbeat) state.pending = { signal: "success", reason: "email_observation_healthy", at: now, ...(run ? { run } : {}) };
  } else {
    // A working API with no proven SMTP delivery is not a green mail check.
    state.status = state.down ? "down" : "unknown";
    if (state.pending?.signal === "success") delete state.pending;
  }
}
