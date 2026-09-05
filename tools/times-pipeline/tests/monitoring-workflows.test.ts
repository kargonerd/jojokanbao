import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function reportStep(file: string, job: string) {
  const workflow = parse(readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), "utf8"));
  return workflow.jobs[job].steps.find((step: { env?: Record<string, string> }) =>
    step.env?.HEALTHCHECKS_FAILURE_TYPE?.includes("job.status"));
}

// These expressions only use boolean operators shared by Actions and JS.
// Exercise the actual YAML so changes to the reporting gate are covered.
function evaluate(expression: string, context: Record<string, unknown>) {
  const body = expression.trim().slice(3, -2);
  return new Function(...Object.keys(context), `return (${body});`)(...Object.values(context));
}

describe("maintenance outcome reporting", () => {
  it.each([
    ["maintenance-times-capture.yml", "capture"],
    ["maintenance-times-process.yml", "process"],
    ["maintenance-sync-rmrb.yml", "sync-rmrb"],
  ])("buffers %s outcomes in the shared policy inbox without new credentials", (file, job) => {
    const workflow = parse(readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), "utf8"));
    expect(workflow.jobs[job].env.HEALTHCHECKS_REPORT_MODE).toBe("buffered");
    expect(workflow.jobs[job].env.HEALTHCHECKS_PING_KEY).toBe("${{ secrets.HEALTHCHECKS_PING_KEY }}");
    const validations = workflow.jobs[job].steps.filter((step: { name?: string }) => step.name?.startsWith("Validate"));
    for (const step of validations) expect(step.run).toContain("source tools/monitoring/classify-permanent.sh");
  });
  const process = reportStep("maintenance-times-process.yml", "process");
  const capture = reportStep("maintenance-times-capture.yml", "capture");
  it("keeps Capture and committed Process outcomes on separate managed checks", () => {
    expect(capture.env.HEALTHCHECKS_TASK_ID).toBe("times-capture");
    expect(process.env.HEALTHCHECKS_TASK_ID).toBe("times-process");
  });

  it.each([true, false])("only reports publishing automatic Capture runs (publish=%s)", (publish) => {
    for (const automatic of [true, false]) {
      expect(Boolean(evaluate(capture.if, { always: () => true, inputs: { automatic, publish } })))
        .toBe(automatic && publish);
    }
  });
  it.each([
    ["workflow_run", {}, "success", true, true],
    ["workflow_run", {}, "success", false, false],
    ["workflow_run", {}, "failure", false, true],
    ["workflow_dispatch", { publish: true, drain: true }, "success", true, true],
    ["workflow_dispatch", { publish: true, drain: true }, "failure", false, true],
    ["workflow_dispatch", { publish: true, drain: true }, "cancelled", false, true],
    ["workflow_dispatch", { publish: true, drain: true }, "success", false, false],
    ["workflow_dispatch", { publish: false, drain: true }, "failure", false, false],
    ["workflow_dispatch", { publish: true, drain: false }, "success", true, false],
    ["workflow_dispatch", { publish: true, drain: true, bootstrap: true }, "success", true, false],
    ["workflow_dispatch", { publish: true, drain: true, capture_run_id: "123" }, "failure", false, false],
  ])("reports %s %j %s committed=%s as %s", (event, inputs, status, committed, expected) => {
    expect(Boolean(evaluate(process.if, {
      always: () => true,
      github: { event_name: event },
      inputs,
      job: { status },
      env: { TIMES_BATCH_COMMITTED: String(committed) },
    }))).toBe(expected);
  });

  it.each(["success", "failure", "cancelled"])("labels %s outcomes consistently", (status) => {
    for (const step of [capture, process, reportStep("maintenance-sync-rmrb.yml", "sync-rmrb")]) {
      expect(evaluate(step.env.HEALTHCHECKS_FAILURE_TYPE, { job: { status } }))
        .toBe(status === "success" ? "" : "run-failed");
    }
  });
});
