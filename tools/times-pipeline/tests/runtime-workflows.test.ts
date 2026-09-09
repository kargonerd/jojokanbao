import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

async function workflow(name: string): Promise<string> {
  return readFile(path.resolve("..", "..", ".github", "workflows", name), "utf8");
}

function ordered(body: string, values: string[]): void {
  const indexes = values.map((value) => body.indexOf(value));
  expect(indexes.every((index) => index >= 0)).toBe(true);
  expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
}

describe("Times Runtime workflows", () => {
  it.each(["capture", "process", "runtime-cleanup"])("saves prepared %s runtime before business steps", async (name) => {
    const body = await workflow(`maintenance-times-${name}.yml`);
    ordered(body, ["Restore CI-verified Times runtime", "Prepare Times runtime on cache miss", "Save prepared Times runtime"]);
    expect(body).toContain("actions/cache/restore@");
    expect(body).toContain("actions/cache/save@");
    expect(body).toContain("key: ${{ steps.times_runtime_cache.outputs.cache-primary-key }}");
    expect(body).not.toContain("pnpm install --frozen-lockfile\n");
  });

  it("bounds browser dependencies separately from cached binaries and saves early", async () => {
    const body = await workflow("maintenance-times-capture.yml");
    const steps = parse(body).jobs.capture.steps as Array<{ name?: string; run?: string; "timeout-minutes"?: number; with?: { path?: string } }>;
    const deps = steps.find((step) => step.name === "Install browser system dependencies")!;
    expect(deps["timeout-minutes"]).toBe(5);
    expect(deps.run).toContain("with-apt-timeouts.sh");
    expect(deps.run).toContain("install-deps chromium");
    expect(body).not.toContain("--with-deps");
    ordered(body, ["Install pinned Brave", "Save prepared browser cache", "Capture all enabled sources"]);
    const cache = steps.find((step) => step.name === "Save pinned Mihomo archive")!;
    expect(cache.with?.path).toBe("${{ runner.temp }}/mihomo-cache");
    ordered(body, ["Prepare pinned Mihomo binary", "Save pinned Mihomo archive", "Start pinned Mihomo for"]);
  });

  it("skips rclone installation for empty Process triggers and bounds apt", async () => {
    const body = await workflow("maintenance-times-process.yml");
    const step = parse(body).jobs.process.steps.find((step: { name?: string }) => step.name === "Install rclone for publication");
    expect(step.if).toContain("env.TIMES_RUNTIME_HAS_WORK == 'true'");
    expect(step["timeout-minutes"]).toBe(5);
    expect(step.run).toContain("with-apt-timeouts.sh");
    ordered(body, ["--action select-jobs", "Install rclone for publication"]);
  });

  it("queues both Delivery writers without replacing pending cleanup or releasing their shared lock", async () => {
    for (const name of ["maintenance-times-process.yml", "maintenance-times-runtime-cleanup.yml"]) {
      const body = parse(await workflow(name));
      const job = body.jobs.process ?? body.jobs.cleanup;
      expect(job.concurrency).toEqual({
        group: "times-delivery-writer",
        queue: "max",
        "cancel-in-progress": false,
      });
      expect(body.concurrency?.group).not.toBe("times-delivery-writer");
    }
  });

  it("persists encrypted subscriptions only after a healthy proxy on master, outside Actions caches", async () => {
    const body = await workflow("maintenance-times-capture.yml");
    const steps = parse(body).jobs.capture.steps;
    const start = steps.find((step: { name?: string }) => step.name === "Start pinned Mihomo for a configured subscription");
    const save = steps.find((step: { name?: string }) => step.name === "Save healthy encrypted proxy subscription");
    expect(start.run).toContain('--cache-bucket "$HF_TIMES_RUNTIME_BUCKET"');
    expect(start.run).toContain('[ "$TIMES_PUBLISH" = "true" ]');
    expect(start.run).toContain("curl --proxy http://127.0.0.1:7890");
    expect(save.if).toContain("github.ref == 'refs/heads/master'");
    expect(save.if).toContain("env.TIMES_PUBLISH == 'true'");
    expect(save.if).not.toContain("always()");
    expect(save["continue-on-error"]).toBe(true);
    expect(save["timeout-minutes"]).toBe(1);
    expect(save.run).toContain("--action commit-cache");
    ordered(body, [start.name, save.name, "Capture all enabled sources"]);
    expect(body).toContain("proxy.source === \"cache\"");
    for (const step of steps.filter((step: { uses?: string }) => /actions\/(cache|upload-artifact)/.test(step.uses ?? ""))) {
      expect(step.with?.path).not.toMatch(/config\.yaml|subscription|\/mihomo\s*$/m);
    }
  });

  it.each([false, true])("reports normal cache reuse separately from failed refresh fallback (%s)", async (fallback) => {
    const body = parse(await workflow("maintenance-times-capture.yml"));
    const step = body.jobs.capture.steps.find((step: { name?: string }) => step.name === "Publish capture summary");
    const script = step.run.match(/^node[^\n]*\n([\s\S]*)\nNODE\s*$/)?.[1];
    expect(script).toBeDefined();
    const files = new Map([
      ["/runner/proxy-preparation.json", JSON.stringify({ source: "cache", nodes: 1, cacheAgeSeconds: 7200,
        ...(fallback ? { failure: { kind: "network", retryable: true } } : {}) })],
      ["/runner/capture-result.json", JSON.stringify({ runId: "capture", results: [] })],
    ]);
    const lines: string[] = [];
    runInNewContext(script, {
      require: (name: string) => {
        expect(name).toBe("node:fs");
        return { existsSync: (file: string) => files.has(file), readFileSync: (file: string) => files.get(file) };
      },
      process: { env: { RUNNER_TEMP: "/runner" } },
      console: { log: (line: string) => lines.push(line) },
    }, { timeout: 1000 });
    const summary = lines.join("\n");
    if (fallback) {
      expect(summary).toContain("Warning: Proxy subscription refresh failed");
      expect(summary).toContain("expires after 24 hours");
    } else {
      expect(summary).toContain("refresh every 12 hours");
      expect(summary).not.toContain("Warning:");
    }
  });

  it("coalesces only interchangeable Process requests and keeps manual requests unique", async () => {
    const body = parse(await workflow("maintenance-times-process.yml"));
    expect(body.concurrency.queue).toBe("single");
    expect(body.concurrency["cancel-in-progress"]).toBe(false);
    const evaluate = (expression: string, github: object, inputs: object) => new Function(
      "github", "inputs", "format", `return (${expression.slice(3, -2)});`,
    )(github, inputs, (pattern: string, value: string | number) => pattern.replace("{0}", String(value)));
    const defaults = { publish: false, drain: false, bootstrap: false, capture_run_id: "", runtime_job_id: "" };
    const automaticCapture = { conclusion: "success", event: "workflow_dispatch", display_title: "Times capture [cloudflare-cron]" };
    const cases = [
      { event: "workflow_run", upstream: automaticCapture, inputs: {}, auto: true },
      { event: "workflow_run", upstream: { ...automaticCapture, event: "schedule" }, inputs: {}, auto: true },
      { event: "workflow_run", upstream: { ...automaticCapture, conclusion: "failure" }, inputs: {}, auto: false },
      { event: "workflow_run", upstream: { ...automaticCapture, display_title: "manual dry run" }, inputs: {}, auto: false },
      { event: "workflow_dispatch", inputs: { publish: true, drain: true }, auto: true },
      { event: "workflow_dispatch", inputs: { publish: true, drain: false }, auto: false },
      { event: "workflow_dispatch", inputs: { publish: false, drain: true }, auto: false },
      { event: "workflow_dispatch", inputs: { publish: true, drain: true, runtime_job_id: "123-1" }, auto: false },
      { event: "workflow_dispatch", inputs: { publish: true, drain: true, bootstrap: true }, auto: false },
      { event: "workflow_dispatch", inputs: { capture_run_id: "123" }, auto: false },
    ];
    for (const [index, test] of cases.entries()) {
      const github = { event_name: test.event, ref: "refs/heads/master", run_id: 100 + index, event: { workflow_run: test.upstream ?? {} } };
      const inputs = { ...defaults, ...test.inputs };
      expect(evaluate(body.concurrency.group, github, inputs)).toBe(test.auto ? "times-process-automatic-refs/heads/master" : `times-process-request-${100 + index}`);
      if (test.auto) expect(evaluate(body.concurrency.group, { ...github, ref: "refs/heads/other" }, inputs)).toBe("times-process-automatic-refs/heads/other");
      expect(evaluate(body["run-name"], github, inputs)).toBe(test.auto ? "Times process [automatic]" : `Times process [request ${100 + index}]`);
    }
    const drain = body.jobs.process.steps.find((step: { name?: string }) => step.name === "Continue draining Runtime jobs");
    expect(drain.run.trim()).toBe("node tools/ci/continue-times-process.mjs");
  });

  it("publishes Raw marker-last, then advances Capture memory without Dataset writes", async () => {
    const body = await workflow("maintenance-times-capture.yml");
    expect(body).toContain("name: Maintenance · Times Capture");
    expect(body).toContain("group: times-capture");
    expect(body).toContain("timeout-minutes: 35");
    expect(body).toContain("github.run_attempt");
    expect(body).toContain("HF_TIMES_RUNTIME_BUCKET");
    expect(body).not.toContain("HF_TIMES_DATASET_REPO");
    expect(body).not.toContain("--action upload-raw");
    ordered(body, ["Publish durable Runtime job", "Save Capture memory"]);
    expect(body).toMatch(
      /name: Restore Capture memory[\s\S]*?continue-on-error: true/u,
    );
    expect(body).toMatch(
      /name: Save Capture memory[\s\S]*?continue-on-error: true/u,
    );
    expect(body).toContain("--action publish-memory");
    expect(body).toContain("--kind capture");
    expect(body).toContain("Restore CI-verified Times runtime");
    expect(body).toContain("Prepare Times runtime on cache miss");
    expect(body).toContain('node "$TIMES_RUNTIME_ROOT/dist/src/capture-cli.js"');
    expect(body).not.toContain("pnpm --filter @jojo/times-pipeline typecheck");
    expect(body).not.toContain("pnpm --filter @jojo/times-pipeline test");
  });

  it("coalesces a Runtime batch, stages it before B2, and drains remaining work", async () => {
    const body = await workflow("maintenance-times-process.yml");
    expect(body).toContain('workflows: ["Maintenance · Times Capture"]');
    expect(body).toContain("group: times-delivery-writer");
    expect(body).toContain("actions: write");
    expect(body).toContain("timeout-minutes: 40");
    expect(body).toContain("github.event.workflow_run.run_attempt");
    expect(body).not.toContain("HF_TIMES_DATASET_REPO");
    expect(body).not.toContain("--action upload-canonical");
    expect(body).toContain("capture_run_id is a dry-run artifact and cannot be published");
    expect(body).toContain("Process memory is missing; use one reviewed manual bootstrap run");
    ordered(body, [
      "--action select-jobs",
      "--action restore-process",
      "--action restore-jobs",
      "--action stage-process",
      "Publish B2 Delivery in commit order",
      "--action promote-process",
      "--action mark-jobs",
      "Continue draining Runtime jobs",
    ]);
    expect(body).toContain('--max-jobs "$TIMES_MAX_JOBS"');
    expect(body).toContain('--job-ids-file "$RUNNER_TEMP/runtime-job-ids.json"');
    expect(body).toContain("env.TIMES_BATCH_COMMITTED == 'true'");
    expect(body).toContain("Restore CI-verified Times runtime");
    expect(body).toContain("Prepare Times runtime on cache miss");
    expect(body).toContain('node "$TIMES_RUNTIME_ROOT/dist/src/process-cli.js"');
  });

  it("builds and caches the Times runtime only in CI", async () => {
    const body = await workflow("ci.yml");
    expect(body).toContain("times_pipeline:");
    expect(body).toContain("Restore Times runtime package");
    expect(body).toContain("Ensure Times runtime build exists");
    expect(body).toContain(".times-runtime");
    const steps = parse(body).jobs.node.steps;
    const contracts = steps.find((step: { name?: string }) => step.name === "Check maintenance workflow contracts");
    expect(contracts.if).toBe("needs.changes.outputs.times_pipeline == 'true'");
    expect(contracts.run).toContain("tests/monitoring-workflows.test.ts");
    expect(contracts.run).toContain("bash -n tools/ci/with-apt-timeouts.sh");
  });

  it("runs cleanup separately with the same writer lock and an explicit apply flag", async () => {
    const body = await workflow("maintenance-times-runtime-cleanup.yml");
    expect(body).toContain("group: times-delivery-writer");
    expect(body).toContain("--action cleanup");
    expect(body).toContain('--apply "$TIMES_CLEANUP_APPLY"');
    expect(body).toContain("--max-delete-jobs");
  });
});
