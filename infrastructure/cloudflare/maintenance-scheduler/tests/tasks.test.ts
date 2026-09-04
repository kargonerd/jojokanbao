import { describe, expect, it } from "vitest";

import { SCHEDULED_TASKS, scheduledTask, validateScheduledTasks } from "../src/tasks";
import { taskHealthcheck } from "../src/types";

describe("scheduled task registry", () => {
  it("contains valid, unique production definitions", () => {
    expect(() => validateScheduledTasks()).not.toThrow();
  });

  it("rejects duplicate task ids", () => {
    const task = scheduledTask("rmrb-sync");
    expect(() => validateScheduledTasks([...SCHEDULED_TASKS, task]))
      .toThrow("Duplicate scheduled task id: rmrb-sync");
  });

  it("derives the Healthchecks slug and schedule from the task id", () => {
    expect(taskHealthcheck(scheduledTask("rmrb-sync"))).toMatchObject({
      slug: "rmrb-sync",
      schedule: "0 1 * * *",
      timeZone: "UTC",
    });
  });
});
