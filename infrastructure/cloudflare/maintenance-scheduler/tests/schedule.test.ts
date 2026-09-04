import { describe, expect, it } from "vitest";

import { compactDateAt, resolveScheduledSlot } from "../src/schedule";
import { scheduledTask } from "../src/tasks";

describe("resolveScheduledSlot", () => {
  it("keeps Times in the current five-minute slot during catch-up probes", () => {
    const slot = resolveScheduledSlot(
      scheduledTask("times-capture"),
      Date.parse("2026-08-29T00:23:00.000Z"),
    );

    expect(slot).toEqual({
      id: "times-capture:2026-08-29T00:20:00.000Z",
      scheduledAtMs: Date.parse("2026-08-29T00:20:00.000Z"),
      scheduledAt: "2026-08-29T00:20:00.000Z",
      endsAtMs: Date.parse("2026-08-29T00:25:00.000Z"),
      endsAt: "2026-08-29T00:25:00.000Z",
    });
  });

  it("keeps RMRB due inside its bounded catch-up window", () => {
    expect(resolveScheduledSlot(
      scheduledTask("rmrb-sync"),
      Date.parse("2026-08-29T03:59:00.000Z"),
    )?.scheduledAt).toBe("2026-08-29T01:00:00.000Z");

    expect(resolveScheduledSlot(
      scheduledTask("rmrb-sync"),
      Date.parse("2026-08-29T04:00:00.000Z"),
    )).toBeUndefined();
  });
});

describe("compactDateAt", () => {
  it("derives the business date in the configured timezone", () => {
    expect(compactDateAt(Date.parse("2026-08-29T16:30:00.000Z"), "Asia/Shanghai"))
      .toBe("20260830");
  });
});
