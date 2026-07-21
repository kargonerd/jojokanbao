import { describe, expect, it } from "vitest";
import { estimateReadingTime, formatCompactDate, sortByDate } from "../src/lib/blog";

describe("blog helpers", () => {
  it("sorts posts from newest to oldest without mutating the input", () => {
    const entries = [
      { data: { date: new Date("2026-07-18T00:00:00+08:00") }, title: "older" },
      { data: { date: new Date("2026-07-19T00:00:00+08:00") }, title: "newer" },
    ];

    expect(sortByDate(entries).map((entry) => entry.title)).toEqual(["newer", "older"]);
    expect(entries.map((entry) => entry.title)).toEqual(["older", "newer"]);
  });

  it("formats dates for the article list", () => {
    expect(formatCompactDate(new Date("2026-07-19T00:00:00+08:00"))).toBe("2026.07.19");
  });

  it("never reports less than one minute", () => {
    expect(estimateReadingTime("短文")).toBe(1);
    expect(estimateReadingTime("字".repeat(901))).toBe(3);
  });
});
