import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function workflow(name: string): Promise<string> {
  return readFile(path.resolve("..", "..", ".github", "workflows", name), "utf8");
}

function ordered(body: string, values: string[]): void {
  const indexes = values.map((value) => body.indexOf(value));
  expect(indexes.every((index) => index >= 0)).toBe(true);
  expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
}

describe("Times Runtime workflows", () => {
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
  });

  it("runs cleanup separately with the same writer lock and an explicit apply flag", async () => {
    const body = await workflow("maintenance-times-runtime-cleanup.yml");
    expect(body).toContain("group: times-delivery-writer");
    expect(body).toContain("--action cleanup");
    expect(body).toContain('--apply "$TIMES_CLEANUP_APPLY"');
    expect(body).toContain("--max-delete-jobs");
  });
});
