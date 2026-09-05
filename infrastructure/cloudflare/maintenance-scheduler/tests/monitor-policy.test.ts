import { describe, expect, it } from "vitest";
import { applyDispatch, applyExecution, DEFAULT_ALERT_POLICY as policy, evaluateDeadline, initialState, observeExpectedSlot, type ExecutionEvent } from "../src/monitor-policy";
import { configuredMonitor } from "../src/monitor-object";

const start = Date.parse("2026-09-05T04:00:00Z");
const check = configuredMonitor("times-capture").check;
const event = (id: string, minute: number, outcome: ExecutionEvent["outcome"] = "failure", permanent = false): ExecutionEvent =>
  ({ id, at: start + minute * 60_000, outcome, permanent, run: `https://github.com/kargonerd/jojokanbao/actions/runs/${id.split(":")[0]}` });

describe("shared alert policy", () => {
  it("ignores stale overlapping dispatch ticks after reconciliation", () => {
    const state = initialState(check, "test", start);
    applyDispatch(state, { kind: "accepted" }, start + 2 * 60_000);
    applyDispatch(state, { kind: "failed", permanent: true, reason: "old 401" }, start + 60_000);
    expect(state.down).toBe(false);
    expect(state.dispatchFailedAt).toBeUndefined();
  });
  it("does not clear a newer dispatch incident with a delayed old completion", () => {
    const state = initialState(check, "test", start);
    applyDispatch(state, { kind: "failed", permanent: true, reason: "401" }, start + 3 * 60_000);
    applyExecution(state, check, policy, event("1:1", 2, "success"));
    expect(state.down).toBe(true);
    expect(state.pending?.signal).toBe("fail");
    expect(state.dispatchFailedAt).toBe(start + 3 * 60_000);
  });
  it("arms the very first expected execution once and never pushes its deadline", () => {
    const state = initialState(check, "new", start + 1000);
    observeExpectedSlot(state, check, start, start + 1000);
    expect(state.pending?.signal).toBe("start");
    expect(state.deadlineAt).toBe(start + 45 * 60_000);
    delete state.pending;
    observeExpectedSlot(state, check, start + 5 * 60_000, start + 5 * 60_000);
    expect(state.pending).toBeUndefined();
    expect(state.deadlineAt).toBe(start + 45 * 60_000);
    evaluateDeadline(state, policy, state.deadlineAt);
    expect(state).toMatchObject({ pending: { signal: "fail" } });
  });
  it("does not resurrect a slot that already completed successfully", () => {
    const state = initialState(check, "new", start);
    applyExecution(state, check, policy, event("1:1", 1, "success"));
    const deadline = state.deadlineAt;
    observeExpectedSlot(state, check, start, start + 2 * 60_000);
    expect(state.deadlineAt).toBe(deadline);
  });
  it("keeps a 502 followed by successful reconciliation quiet", () => {
    const state = initialState(check, "test", start);
    applyDispatch(state, { kind: "failed", permanent: false, reason: "HTTP 502" }, start);
    evaluateDeadline(state, policy, start + 59_000);
    expect(state.pending).toBeUndefined();
    applyDispatch(state, { kind: "accepted" }, start + 60_000);
    evaluateDeadline(state, policy, start + 6 * 60_000);
    expect(state.down).toBe(false);
  });

  it("alerts at five minutes across schedule slots and actor restarts, once", () => {
    let state = initialState(check, "test", start);
    for (let minute = 0; minute <= 5; minute += 1) {
      state = JSON.parse(JSON.stringify(state));
      applyDispatch(state, { kind: "failed", permanent: false, reason: "HTTP 502" }, start + minute * 60_000);
      evaluateDeadline(state, policy, start + minute * 60_000);
      expect(state.down).toBe(minute === 5);
    }
    expect(state.pending?.reason).toBe("dispatch-failure-duration");
    delete state.pending;
    evaluateDeadline(state, policy, start + 10 * 60_000);
    expect(state.pending).toBeUndefined();
  });

  it("counts distinct execution attempts, not duplicate deliveries", () => {
    const state = initialState(check, "test", start);
    applyExecution(state, check, policy, event("1:1", 1));
    applyExecution(state, check, policy, event("1:1", 2));
    expect(state.executionFailures).toBe(1);
    expect(state.pending).toBeUndefined();
    applyExecution(state, check, policy, event("1:2", 3));
    expect(state.pending?.reason).toBe("consecutive-execution-failures");
  });

  it("a real success resets the streak, but a dispatch/no-op does not", () => {
    const state = initialState(check, "test", start);
    applyExecution(state, check, policy, event("1:1", 1));
    applyDispatch(state, { kind: "accepted" }, start + 2 * 60_000);
    expect(state.executionFailures).toBe(1);
    applyExecution(state, check, policy, event("2:1", 3, "success"));
    expect(state.executionFailures).toBe(0);
    delete state.pending;
    applyExecution(state, check, policy, event("3:1", 4));
    expect(state.pending).toBeUndefined();
  });

  it("acceptance never clears an already reported incident", () => {
    const state = initialState(check, "test", start);
    applyDispatch(state, { kind: "failed", permanent: true, reason: "HTTP 401" }, start);
    delete state.pending;
    applyDispatch(state, { kind: "accepted" }, start + 60_000);
    expect(state.down).toBe(true);
    expect(state.pending).toBeUndefined();
    applyExecution(state, check, policy, event("1:1", 2, "success"));
    expect(state.down).toBe(false);
    expect(state).toMatchObject({ pending: { signal: "success" } });
  });

  it("rejects stale successes and duplicate recovery events", () => {
    const state = initialState(check, "test", start);
    applyExecution(state, check, policy, event("1:1", 3, "failure", true));
    applyExecution(state, check, policy, event("2:1", 2, "success"));
    expect(state.down).toBe(true);
    applyExecution(state, check, policy, event("3:1", 4, "success"));
    delete state.pending;
    applyExecution(state, check, policy, event("3:1", 4, "success"));
    expect(state.pending).toBeUndefined();
  });

  it("retries and new slots cannot move the absolute overdue deadline", () => {
    const state = initialState(check, "test", start);
    applyExecution(state, check, policy, event("1:1", 1, "success"));
    const deadline = start + 50 * 60_000; // next due 04:05 + 45m
    expect(state.deadlineAt).toBe(deadline);
    delete state.pending;
    for (let minute = 5; minute <= 50; minute += 5) applyDispatch(state, { kind: "accepted" }, start + minute * 60_000);
    expect(state.deadlineAt).toBe(deadline);
    evaluateDeadline(state, policy, deadline);
    expect(state).toMatchObject({ pending: { reason: "success-overdue" } });
  });

  it("does not briefly clear overdue work with an ancient buffered success", () => {
    const state = initialState(check, "test", start);
    applyExecution(state, check, policy, event("1:1", 1, "success"));
    evaluateDeadline(state, policy, start + 60 * 60_000);
    expect(state.pending?.signal).toBe("fail");
  });

  it("keeps stage incidents independent", () => {
    const capture = initialState(check, "capture", start);
    const processCheck = configuredMonitor("times-process").check;
    const process = initialState(processCheck, "process", start);
    applyExecution(process, processCheck, policy, event("1:1", 1, "failure", true));
    applyExecution(capture, check, policy, event("2:1", 2, "success"));
    expect(process.down).toBe(true);
    expect(capture.down).toBe(false);
  });

  it("waits for three RMRB attempts, or an explicit exhaustion observation", () => {
    const { check: rmrb, policy: retryPolicy } = configuredMonitor("rmrb-sync");
    const state = initialState(rmrb, "rmrb", start);
    applyExecution(state, rmrb, retryPolicy, event("1:1", 1));
    applyExecution(state, rmrb, retryPolicy, event("2:1", 16));
    expect(state.down).toBe(false);
    applyExecution(state, rmrb, retryPolicy, event("3:1", 31));
    expect(state.down).toBe(true);
    const missingReports = initialState(rmrb, "rmrb", start);
    applyDispatch(missingReports, { kind: "exhausted" }, start);
    expect(missingReports.pending?.reason).toBe("execution-attempts-exhausted");
  });

  it("immediately escalates explicitly permanent execution failures", () => {
    const state = initialState(check, "test", start);
    applyExecution(state, check, policy, event("1:1", 1, "failure", true));
    expect(state.pending?.reason).toBe("permanent-execution-failure");
  });
});
