import { describe, expect, it } from "vitest";

import { SCHEDULED_TASKS, scheduledTask, validateScheduledTasks } from "../src/tasks";
import { taskHealthcheck, taskStageHealthchecks } from "../src/types";

describe("scheduled task registry", () => {
  it("derives downstream monitoring from config without another secret or trigger", () => {
    const task = scheduledTask("times-capture");
    expect(taskStageHealthchecks(task)).toEqual([expect.objectContaining({
      slug: "times-process", schedule: task.cron, timeZone: task.timeZone,
    }), expect.objectContaining({ slug: "times-process-queue", schedule: "* * * * *", graceSeconds: 600 })]);
    expect(taskStageHealthchecks(task)[1]).not.toHaveProperty("queue");
    expect(taskHealthcheck(task)).not.toHaveProperty("stages");
  });

  it.each([
    { maxPendingRuns: 0 }, { maxPendingRuns: 100 }, { maxWaitSeconds: 0 },
    { failureSeconds: 600 }, { workflows: [] }, { workflows: ["../escape.yml"] },
    { workflows: ["same.yml", "same.yml"] },
  ])("rejects invalid queue probe policy %j", (override) => {
    const task = scheduledTask("times-capture");
    const stage = task.monitoring.stages![1]!;
    expect(() => validateScheduledTasks([{ ...task, monitoring: { ...task.monitoring, stages: [
      { ...stage, queue: { ...stage.queue!, ...override } },
    ] } }])).toThrow("Invalid queue monitoring policy");
  });

  it.each(["rmrb-sync", "maintenance-scheduler", "times-capture"])("rejects colliding monitor slug %s", (slug) => {
    const task = scheduledTask("times-capture");
    const stage = taskStageHealthchecks(task)[0]!;
    expect(() => validateScheduledTasks([
      { ...task, monitoring: { ...task.monitoring, stages: [{ ...stage, slug }] } },
      scheduledTask("rmrb-sync"),
    ])).toThrow("duplicate Healthchecks slug");
  });

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
