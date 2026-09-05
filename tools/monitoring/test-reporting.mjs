import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/bash.exe" : "bash";
const temporary = mkdtempSync(path.join(tmpdir(), "jojo-monitor-report-test-"));
const report = (signal, extra = {}) => {
  const result = spawnSync(bash, ["-c", 'curl() { printf "%s\\n" "$@"; }; source tools/monitoring/ping-healthchecks.sh'], {
    cwd: root, encoding: "utf8", env: { ...process.env,
      HEALTHCHECKS_PING_KEY: "test-project-key", HEALTHCHECKS_PING_URL: "", HEALTHCHECKS_REPORT_MODE: "buffered",
      HEALTHCHECKS_SIGNAL: signal, HEALTHCHECKS_TASK_ID: "times-process", HEALTHCHECKS_STAGE: "times-process",
      HEALTHCHECKS_FAILURE_CLASS: "unknown", HEALTHCHECKS_STATUS: signal === "success" ? "success" : "failure",
      HEALTHCHECKS_RUN_URL: "https://github.com/kargonerd/jojokanbao/actions/runs/123", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", ...extra,
    },
  });
  if (result.error) throw result.error;
  return result;
};
try {
  for (const [signal, outcome] of [["success", "success"], ["fail", "failure"]]) {
    const result = report(signal);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /monitor_event=v1/);
    assert.match(result.stdout, new RegExp(`outcome=${outcome}`));
    assert.match(result.stdout, /run_id=123\nrun_attempt=2/);
    assert.match(result.stdout, /https:\/\/hc-ping.com\/test-project-key\/times-process\/log\s*$/);
  }
  assert.doesNotMatch(report("log").stdout, /monitor_event=v1/);
  assert.match(report("fail", { HEALTHCHECKS_FAILURE_CLASS: "permanent" }).stdout, /failure_class=permanent/);
  assert.equal(report("fail", { GITHUB_RUN_ID: "" }).status, 2);
  assert.equal(report("fail", { HEALTHCHECKS_FAILURE_CLASS: "invalid" }).status, 2);
  assert.match(report("fail", { HEALTHCHECKS_REPORT_MODE: "direct" }).stdout, /times-process\/fail\s*$/);
  for (const [name, code] of [["explicit", "exit 7"], ["command", "false"], ["success", "true"]]) {
    const output = path.join(temporary, name).replaceAll("\\", "/");
    const result = spawnSync(bash, ["-e", "-c", `source tools/monitoring/classify-permanent.sh; ${code}`], {
      cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_ENV: output },
    });
    assert.equal(result.status, name === "explicit" ? 7 : name === "command" ? 1 : 0, result.stderr);
    if (name === "success") assert.equal(existsSync(output), false);
    else assert.equal(readFileSync(output, "utf8").trim(), "HEALTHCHECKS_FAILURE_CLASS=permanent");
  }
  console.log("Monitoring shell contracts passed (network fully stubbed).");
} finally {
  // Only the unique directory created above, never a computed workspace path.
  rmSync(temporary, { recursive: true, force: true });
}
