import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Capture subscription failover shell", () => {
  it.each([
    { failure: "none", secondary: "https://two.example/sub", selected: 0, prepared: [0] },
    { failure: "prepare-first", secondary: "https://two.example/sub", selected: 1, prepared: [0, 1] },
    { failure: "probe-first", secondary: "https://two.example/sub", selected: 1, prepared: [0, 1] },
    { failure: "prepare-all", secondary: "https://two.example/sub", selected: null, prepared: [0, 1] },
    { failure: "probe-all", secondary: "https://two.example/sub", selected: null, prepared: [0, 1] },
    { failure: "prepare-all", secondary: "", selected: null, prepared: [0] },
    { failure: "prepare-all", secondary: "https://one.example/sub", selected: null, prepared: [0] },
  ])("handles $failure with secondary '$secondary'", async ({ failure, secondary, selected, prepared }) => {
    const body = parse(await readFile(path.resolve("..", "..", ".github/workflows/maintenance-times-capture.yml"), "utf8"));
    const start = body.jobs.capture.steps.find((step: { name?: string }) => step.name === "Start pinned Mihomo for a configured subscription");
    const save = body.jobs.capture.steps.find((step: { name?: string }) => step.name === "Save healthy encrypted proxy subscription");
    const directory = await mkdtemp(path.join(os.tmpdir(), "jojo-proxy-workflow-"));
    directories.push(directory);
    await mkdir(path.join(directory, "mihomo"));
    const root = directory.replaceAll("\\", "/");
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    // Execute the actual workflow scripts, replacing only external programs.
    const stubs = `
node() {
  local action=prepare offset=missing
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --action) action="$2"; shift ;;
      --rotation-offset) offset="$2"; shift ;;
    esac
    shift
  done
  printf '%s:%s\\n' "$action" "$offset" >> "$TEST_EVENTS"
  if [ "$action" = "prepare" ]; then
    if [ "$TEST_FAILURE" = "prepare-all" ] || { [ "$TEST_FAILURE" = "prepare-first" ] && [ "$offset" = "0" ]; }; then return 1; fi
  fi
}
nohup() { return 0; }
kill() { if [ "$1" != "-0" ]; then echo stopped >> "$TEST_EVENTS"; fi; return 0; }
wait() { return 0; }
sleep() { return 0; }
curl() {
  if [ "$TEST_FAILURE" = "probe-all" ] || { [ "$TEST_FAILURE" = "probe-first" ] && [ "$rotation_offset" = "0" ]; }; then return 1; fi
}
`;
    const env = { ...process.env, RUNNER_TEMP: root, TIMES_RUNTIME_ROOT: root, GITHUB_ENV: `${root}/github.env`,
      HF_TIMES_RUNTIME_BUCKET: "test/runtime", TIMES_PUBLISH: "true",
      JOJO_TIMES_PROXY_SUBSCRIPTION: "https://one.example/sub", JOJO_TIMES_PROXY_SUBSCRIPTION_2: secondary,
      TEST_EVENTS: `${root}/events`, TEST_FAILURE: failure };
    const result = spawnSync(bash, ["-c", `set -euo pipefail\n${stubs}\n${start.run}`], { env, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(selected === null ? 1 : 0);
    const events = await readFile(`${root}/events`, "utf8");
    expect(events.match(/prepare:\d/g)).toEqual(prepared.map((offset) => `prepare:${offset}`));
    if (failure.startsWith("probe")) expect(events).toContain("stopped");
    if (selected === null) {
      await expect(readFile(env.GITHUB_ENV, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(env.GITHUB_ENV, "utf8")).toContain(`TIMES_PROXY_ROTATION_OFFSET=${selected}\n`);
      const commit = spawnSync(bash, ["-c", `set -euo pipefail\n${stubs}\nsource "$GITHUB_ENV"\n${save.run}`],
        { env, encoding: "utf8", timeout: 10_000 });
      expect(commit.status, commit.stderr).toBe(0);
      expect(await readFile(`${root}/events`, "utf8")).toContain(`commit-cache:${selected}\n`);
    }
  }, 30_000);
});
