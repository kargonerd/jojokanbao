import { describe, expect, it } from "vitest";
import { EMAIL_MESSAGE_LIMIT, type EmailObservation, type EmailStatus } from "../src/email-events";
import { applyEmailDispatch, applyEmailObservation, countEmailAnomalies, EMAIL_POLICY, evaluateEmailState, initialEmailState } from "../src/email-policy";
import { scheduledTask } from "../src/tasks";
import { taskHealthcheck } from "../src/types";

const base = Date.parse("2026-09-09T00:00:00Z");
const at = (minute: number) => base + minute * 60_000;
const date = (minute: number) => new Date(at(minute)).toISOString();
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const check = taskHealthcheck(scheduledTask("jojo-email-delivery"));
const message = (number: number, created: number, status: EmailStatus) => ({ id: id(number), createdAt: date(created), status });
function observation(run: number, minute: number, changes: Partial<EmailObservation> = {}): EmailObservation {
  return { mail_observation: "v1", task: "jojo-email-delivery", runId: String(run), runAttempt: "1", run: `https://github.com/owner/repo/actions/runs/${run}`,
    eventTime: date(minute), scanStart: date(minute - 1440), scanComplete: true, messages: [], transportProbe: { outcome: "not_run", at: date(minute) }, ...changes };
}
function fixture() {
  const state = initialEmailState(check, id(999), base);
  applyEmailObservation(state, check, observation(1, 1, { transportProbe: { outcome: "success", at: date(1), messageId: id(900) } }));
  delete state.pending;
  return state;
}

describe("email monitoring policy", () => {
  it("keeps a successful empty collector scan unknown until an SMTP delivery is proven", () => {
    const state = initialEmailState(check, id(999), base);
    applyEmailObservation(state, check, observation(1, 1));
    expect(state.collector.lastSuccessAt).toBe(at(1));
    expect(state.status).toBe("unknown");
    expect(state.pending).toBeUndefined();
    expect(fixture().status).toBe("up");
  });

  it("keeps collector failures separate from delivery and allows a later complete scan to repair only the collector", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 2, { scanComplete: false, scanError: "resend_http_503" }));
    expect(state.pending?.reason).toBe("resend_http_503");
    expect(state.transport.lastSuccessAt).toBe(at(1));
    applyEmailObservation(state, check, observation(3, 3));
    expect(state).toMatchObject({ down: false, status: "up", pending: { signal: "success" } });
  });

  it.each(["failed", "suppressed", "canceled", "complained", "bounced"] as const)("records one %s email without raising a service alarm", (status) => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 3, { messages: [message(1, 2, status)] }));
    expect(state).toMatchObject({ down: false, status: "up" });
    expect(state.delivery.incident).toBeUndefined();
    expect(state.messages).toMatchObject([{ id: id(1), status }]);
  });

  it("counts mixed failures once per email, not per scan or status transition", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 11, { messages: [message(1, 0, "delivery_delayed")] }));
    applyEmailObservation(state, check, observation(3, 12, { messages: [message(1, 0, "failed")] }));
    applyEmailObservation(state, check, observation(4, 13, { messages: [message(1, 0, "bounced"), message(2, 12, "suppressed")] }));
    expect(countEmailAnomalies(state, at(13))).toBe(2);
    expect(state.down).toBe(false);
    applyEmailObservation(state, check, observation(5, 14, { messages: [message(3, 0, "sent")] }));
    expect(countEmailAnomalies(state, at(14))).toBe(3);
    expect(state).toMatchObject({ down: true, pending: { reason: "email_failure_threshold" } });
    delete state.pending;
    applyEmailObservation(state, check, observation(6, 15));
    expect(state.down).toBe(true);
    expect(state.pending).toBeUndefined(); // No repeated alarm while still down.
  });

  it("preserves SMTP failure across empty/real-mail scans and a repeated old synthetic id", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 2, { transportProbe: { outcome: "failure", at: date(2), reason: "recover_http_500" } }));
    applyEmailObservation(state, check, observation(3, 4, { messages: [message(1, 3, "delivered")] }));
    applyEmailObservation(state, check, observation(4, 5, { transportProbe: { outcome: "success", at: date(5), messageId: id(900) } }));
    expect(state.down).toBe(true);
    expect(state.transport.lastSuccessAt).toBe(at(1));
    applyEmailObservation(state, check, observation(5, 6, { transportProbe: { outcome: "success", at: date(6), messageId: id(901) } }));
    expect(state.down).toBe(false);
  });

  it("alerts at three delayed emails and recovers below three only after confirmed delivery", () => {
    const state = fixture();
    const delayed = [message(1, 0, "sent"), message(2, 0, "queued"), message(3, 0, "delivery_delayed")];
    applyEmailObservation(state, check, observation(2, 10, { messages: delayed }));
    expect(state.down).toBe(false); // Delay must exceed ten minutes.
    applyEmailObservation(state, check, observation(3, 11, { messages: delayed }));
    expect(state.pending?.reason).toBe("email_failure_threshold");
    applyEmailObservation(state, check, observation(4, 13, { messages: [message(4, 12, "delivered")] }));
    applyEmailObservation(state, check, observation(5, 14));
    expect(state.down).toBe(true); // Unrelated success and disappearance do not resolve delays.
    applyEmailObservation(state, check, observation(6, 15, { scanComplete: false, scanError: "resend_scan_limit", messages: [message(1, 0, "delivered")] }));
    applyEmailObservation(state, check, observation(7, 16));
    expect(state.down).toBe(true); // Partial delivery evidence was not confirmed.
    applyEmailObservation(state, check, observation(8, 17, { messages: [message(1, 0, "delivered")] }));
    expect(state.down).toBe(false);
    expect(countEmailAnomalies(state, at(17))).toBe(2);
    applyEmailObservation(state, check, observation(9, 18, { messages: [message(1, 0, "sent")] }));
    expect(state.down).toBe(false); // A stale provider snapshot cannot undo confirmed delivery.
  });

  it.each([1, 3])("retains %i unresolved delays beyond the normal scan window without marking them delivered", (count) => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 11, { messages: Array.from({ length: count }, (_, index) => message(index + 1, 0, "delivery_delayed")) }));
    applyEmailObservation(state, check, observation(3, 1450, { transportProbe: { outcome: "success", at: date(1450), messageId: id(901) } }));
    expect(state.messages).toHaveLength(count);
    expect(countEmailAnomalies(state, at(1450))).toBe(count);
    expect(state.down).toBe(count >= 3);
  });

  it("counts terminal failures in the 30-minute creation window and requires a complete scan for recovery", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 2, { messages: [message(1, 0, "bounced"), message(2, 1, "failed"), message(9, -40, "bounced")] }));
    expect(state.down).toBe(false);
    applyEmailObservation(state, check, observation(3, 3, { messages: [message(3, 2, "complained")] }));
    expect(state.delivery.incident?.reason).toBe("email_failure_threshold");
    evaluateEmailState(state, at(33));
    expect(state.down).toBe(true); // Time passing alone never sends a recovery ping.
    applyEmailObservation(state, check, observation(4, 34, { scanComplete: false, scanError: "resend_scan_limit" }));
    expect(state.down).toBe(true);
    applyEmailObservation(state, check, observation(5, 35));
    expect(state.down).toBe(false);
    expect(state.messages.filter((entry) => entry.status === "bounced")).toHaveLength(2);
    expect(state.messages.every((entry) => !entry.confirmedDelivery)).toBe(true);
  });

  it("retains failures seen in partial scans and does not accept partial recovery", () => {
    const state = fixture();
    const failures = [message(1, 2, "failed"), message(2, 2, "failed"), message(3, 2, "failed")];
    applyEmailObservation(state, check, observation(2, 3, { scanComplete: false, scanError: "resend_scan_limit", messages: failures }));
    applyEmailObservation(state, check, observation(3, 5, { scanComplete: false, scanError: "resend_scan_limit", messages: [message(1, 2, "delivered")] }));
    applyEmailObservation(state, check, observation(4, 6));
    expect(state.collector.incident).toBeUndefined();
    expect(state.delivery.incident?.reason).toBe("email_failure_threshold");
    expect(state.down).toBe(true);
    applyEmailObservation(state, check, observation(5, 7, { messages: [message(1, 2, "delivered")] }));
    expect(state.down).toBe(false);
  });

  it("does not let unrelated success hide three current failures", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 5, { messages: [message(1, 4, "delivered"), message(2, 4, "failed"), message(3, 4, "bounced"), message(4, 4, "suppressed")] }));
    expect(state.down).toBe(true);
  });

  it.each(["email_failed", "email_delivery_delayed"])("re-evaluates a persisted legacy %s alarm without deleting the message or overriding transport faults", (reason) => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 11, { messages: [message(1, 0, "delivery_delayed")] }));
    state.down = true; state.status = "down";
    state.delivery.incident = { at: at(11), reason };
    state.pending = { signal: "fail", at: at(11), reason };
    evaluateEmailState(state, at(12));
    expect(state.down).toBe(true);
    applyEmailObservation(state, check, observation(3, 13, { transportProbe: { outcome: "failure", at: date(13), reason: "transport_timeout" } }));
    expect(state.delivery.incident).toBeUndefined();
    expect(state).toMatchObject({ down: true, pending: { reason: "transport_timeout" } });
    applyEmailObservation(state, check, observation(4, 14, { transportProbe: { outcome: "success", at: date(14), messageId: id(901) } }));
    expect(state).toMatchObject({ down: false, pending: { signal: "success" } });
    expect(state.messages).toMatchObject([{ id: id(1), status: "delivery_delayed", confirmedDelivery: false }]);
  });

  it("deduplicates run attempts and ignores outcomes older than the applied observation", () => {
    const state = fixture();
    const failure = observation(2, 3, { messages: [message(1, 2, "failed")] });
    applyEmailObservation(state, check, failure);
    const snapshot = structuredClone(state);
    applyEmailObservation(state, check, { ...failure, eventTime: date(4) });
    applyEmailObservation(state, check, observation(3, 2));
    expect(state).toEqual(snapshot);
  });

  it("fails closed before exceeding bounded event state", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 2, { messages: Array.from({ length: EMAIL_MESSAGE_LIMIT }, (_, index) => message(index + 1, 1, "delivered")) }));
    applyEmailObservation(state, check, observation(3, 3, { messages: [message(201, 2, "delivered")] }));
    expect(state.messages).toHaveLength(200);
    expect(state.collector.incident?.reason).toBe("email_state_capacity");
    expect(JSON.stringify(state).length).toBeLessThan(131072);
  });

  it("keeps dispatch and silent-workflow deadlines, and does not claim recovery on dispatch acceptance alone", () => {
    const state = fixture();
    applyEmailDispatch(state, { kind: "failed", permanent: true, reason: "unauthorized" }, at(2));
    evaluateEmailState(state, at(2));
    expect(state.pending?.signal).toBe("fail");
    delete state.pending;
    applyEmailDispatch(state, { kind: "accepted" }, at(3));
    evaluateEmailState(state, at(3));
    expect(state.down).toBe(true);
    expect(state.pending).toBeUndefined();
    applyEmailObservation(state, check, observation(2, 4));
    expect(state).toMatchObject({ pending: { signal: "success" } });
    evaluateEmailState(state, state.deadlineAt);
    expect(state).toMatchObject({ pending: { reason: "email_observation_overdue" } });
  });

  it("expires old SMTP evidence even when normal API scans continue", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, EMAIL_POLICY.transportMaxAgeSeconds / 60 + 2));
    expect(state.pending?.reason).toBe("email_transport_overdue");
    expect(state.down).toBe(true);
  });

  it("recovers an earlier dispatch fault with a real workflow observation before a subsequent dispatch is applied", () => {
    const state = fixture();
    applyEmailDispatch(state, { kind: "failed", permanent: true, reason: "unauthorized" }, at(2));
    evaluateEmailState(state, at(2));
    delete state.pending;
    applyEmailObservation(state, check, observation(2, 3));
    expect(state.dispatch.failure).toBeUndefined();
    expect(state).toMatchObject({ down: false, pending: { signal: "success" } });
    applyEmailDispatch(state, { kind: "failed", permanent: true, reason: "unauthorized" }, at(4));
    evaluateEmailState(state, at(4));
    expect(state).toMatchObject({ down: true, pending: { signal: "fail", reason: "email_dispatch_failed" } });
  });
});
