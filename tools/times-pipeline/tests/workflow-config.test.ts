import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Times workflow configuration", () => {
  it("keeps automatic discovery bounded to the initialized Capture memory", async () => {
    const workflowPath = fileURLToPath(new URL(
      "../../../.github/workflows/maintenance-times-capture.yml",
      import.meta.url,
    ));
    const workflow = parse(await readFile(workflowPath, "utf8")) as {
      jobs?: { capture?: { env?: Record<string, string> } };
    };

    expect(workflow.jobs?.capture?.env?.TIMES_DISCOVERY_HOURS)
      .toBe("${{ inputs.automatic && '3' || inputs.since_hours || '24' }}");
    expect(workflow.jobs?.capture?.env?.TIMES_PROCESS_WINDOW_HOURS)
      .toBe("${{ inputs.automatic && '1' || inputs.since_hours || '24' }}");
  });
});
