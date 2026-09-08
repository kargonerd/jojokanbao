import { describe, expect, it } from "vitest";
import { EMAIL_MESSAGE_LIMIT, type EmailObservation, type EmailStatus } from "../src/email-events";
import { applyEmailDispatch, applyEmailObservation, EMAIL_POLICY, evaluateEmailState, initialEmailState } from "../src/email-policy";
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

  it("does not clear a terminal delivery failure with empty scans, old delivered mail, or a synthetic success", () => {
    const state = fixture();
    const failed = message(1, 2, "failed");
    applyEmailObservation(state, check, observation(2, 3, { messages: [failed] }));
    const incidentAt = state.delivery.incident!.at;
    applyEmailObservation(state, check, observation(3, 4));
    applyEmailObservation(state, check, observation(4, 5, { messages: [failed, message(2, 1, "delivered")] }));
    applyEmailObservation(state, check, observation(5, 6, { messages: [message(901, 5, "delivered")], transportProbe: { outcome: "success", at: date(6), messageId: id(901) } }));
    expect(state.delivery.incident?.at).toBe(incidentAt);
    expect(state.down).toBe(true);
    applyEmailObservation(state, check, observation(6, 8, { messages: [failed, message(3, 7, "delivered")] }));
    expect(state.down).toBe(false);
    expect(state.delivery.incident).toBeUndefined();
    applyEmailObservation(state, check, observation(7, 9, { messages: [failed] }));
    expect(state.down).toBe(false); // Same failed email is not a fresh incident.
  });

  it("does not mistake a previously tracked old email's delivery transition for recovery of an unrelated newer fault", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 2, { messages: [message(1, 1, "sent")] }));
    applyEmailObservation(state, check, observation(3, 4, { messages: [message(2, 3, "suppressed")] }));
    applyEmailObservation(state, check, observation(4, 5, { messages: [message(1, 1, "delivered")] }));
    expect(state.delivery.incident?.reason).toBe("email_suppressed");
    expect(state.down).toBe(true);
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

  it("holds unresolved delayed emails across empty scans and other successes until their own state changes", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 5, { messages: [message(1, 0, "sent")] }));
    expect(state.down).toBe(false);
    applyEmailObservation(state, check, observation(3, 11, { messages: [message(1, 0, "sent")] }));
    expect(state.pending?.reason).toBe("email_delivery_delayed");
    applyEmailObservation(state, check, observation(4, 13, { messages: [message(2, 12, "delivered")] }));
    applyEmailObservation(state, check, observation(5, 14));
    expect(state.down).toBe(true);
    applyEmailObservation(state, check, observation(6, 15, { messages: [message(1, 0, "delivered")] }));
    expect(state.down).toBe(false);
  });

  it("does not drop an unresolved delayed email when it ages out of the normal scan window", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 11, { messages: [message(1, 0, "delivery_delayed")] }));
    applyEmailObservation(state, check, observation(3, 1450, { transportProbe: { outcome: "success", at: date(1450), messageId: id(901) } }));
    expect(state.messages.some((entry) => entry.id === id(1))).toBe(true);
    expect(state.down).toBe(true);
  });

  it("counts distinct recent bounced messages and leaves that incident latched until real recovery", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 2, { messages: [message(1, 0, "bounced"), message(2, 1, "bounced"), message(9, -40, "bounced")] }));
    expect(state.down).toBe(false);
    applyEmailObservation(state, check, observation(3, 3, { messages: [message(1, 0, "bounced"), message(2, 1, "bounced"), message(3, 2, "bounced")] }));
    expect(state.delivery.incident?.reason).toBe("email_bounce_threshold");
    applyEmailObservation(state, check, observation(4, 40));
    expect(state.down).toBe(true); // Window expiry and no traffic are not recovery.
  });

  it("retains failures seen in a partial scan but never recovers delivery from its partial successes", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 3, { scanComplete: false, scanError: "resend_scan_limit", messages: [message(1, 2, "failed")] }));
    applyEmailObservation(state, check, observation(3, 5, { scanComplete: false, scanError: "resend_scan_limit", messages: [message(2, 4, "delivered")] }));
    applyEmailObservation(state, check, observation(4, 6));
    expect(state.collector.incident).toBeUndefined();
    expect(state.delivery.incident?.reason).toBe("email_failed");
    expect(state.down).toBe(true);
    applyEmailObservation(state, check, observation(5, 7, { messages: [message(2, 4, "delivered")] }));
    expect(state.down).toBe(false); // First complete confirmation of that new mail.
  });

  it("gives new failures precedence when a complete scan also contains new delivery evidence", () => {
    const state = fixture();
    applyEmailObservation(state, check, observation(2, 5, { messages: [message(1, 4, "delivered"), message(2, 4, "failed")] }));
    expect(state.down).toBe(true);
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
