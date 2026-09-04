import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/release-mobile-ota.yml", import.meta.url));

test("uses production-only percentage rollouts", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /eas_channel=production-standard/);
  assert.match(workflow, /eas_channel=production-eink/);
  assert.match(workflow, /--rollout-percentage "\$ROLLOUT_PERCENTAGE"/);
  assert.match(workflow, /eas update:edit "\$UPDATE_GROUP_ID"/);
  assert.match(workflow, /eas update:revert-update-rollout/);
  assert.match(workflow, /New OTA updates must begin as a partial rollout/);
  assert.doesNotMatch(workflow, /preview-standard|preview-eink/);
});
