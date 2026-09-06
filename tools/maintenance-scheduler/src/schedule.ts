import { Cron } from "croner";

import type { ScheduledSlot, ScheduledTask } from "./types";

function cronSchedule(expression: string, timeZone: string): Cron {
  return new Cron(expression, { paused: true, timezone: timeZone });
}

export function resolveScheduledSlot(
  task: ScheduledTask,
  observedAtMs: number,
): ScheduledSlot | undefined {
  if (!Number.isFinite(observedAtMs)) {
    throw new Error(`Scheduled time is invalid for ${task.id}`);
  }
  if (task.catchupWindowMinutes <= 0) {
    throw new Error(`Catch-up window must be positive for ${task.id}`);
  }

  const schedule = cronSchedule(task.cron, task.timeZone);
  const observedMinute = new Date(Math.floor(observedAtMs / 60_000) * 60_000);
  const previous = schedule.match(observedMinute)
    ? observedMinute
    : schedule.previousRuns(1, observedMinute)[0];
  if (!previous) {
    throw new Error(`Could not resolve the previous scheduled time for ${task.id}`);
  }
  const scheduledAtMs = previous.getTime();
  const catchupWindowMs = task.catchupWindowMinutes * 60 * 1_000;
  if (observedAtMs - scheduledAtMs >= catchupWindowMs) {
    return undefined;
  }

  const next = schedule.nextRun(new Date(scheduledAtMs));
  if (!next) {
    throw new Error(`Could not resolve the next scheduled time for ${task.id}`);
  }
  const endsAtMs = next.getTime();
  const scheduledAt = new Date(scheduledAtMs).toISOString();

  return {
    id: `${task.id}:${scheduledAt}`,
    scheduledAtMs,
    scheduledAt,
    endsAtMs,
    endsAt: new Date(endsAtMs).toISOString(),
  };
}

export function compactDateAt(timestampMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) {
    throw new Error(`Could not format business date in ${timeZone}`);
  }
  return `${values.year}${values.month}${values.day}`;
}
