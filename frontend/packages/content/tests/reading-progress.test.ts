import { describe, expect, it } from "vitest";
import {
  bookProgressLocation,
  bookProgressPercent,
  estimatedReadingMinutes,
  formatReadingTime,
} from "../src/reading-progress";

const chapters = [{ id: "short", characterCount: 100 }, { id: "long", characterCount: 900 }];

describe("whole-book reading progress", () => {
  it("weights chapters by text length instead of treating every chapter equally", () => {
    expect(bookProgressPercent(chapters, "short", 50)).toBe(5);
    expect(bookProgressPercent(chapters, "short", 100)).toBe(10);
    expect(bookProgressPercent(chapters, "long", 50)).toBeCloseTo(55);
    const middle = bookProgressLocation(chapters, 55)!;
    expect(middle.chapterId).toBe("long");
    expect(middle.chapterProgress).toBeCloseTo(50);
    expect(bookProgressLocation(chapters, 10)).toEqual({ chapterId: "long", chapterProgress: 0 });
  });

  it.each([0, 0.1, 5, 9.99, 10, 10.01, 55, 99.9, 100])("round-trips the slider at %s percent", (percent) => {
    const location = bookProgressLocation(chapters, percent)!;
    expect(bookProgressPercent(chapters, location.chapterId, location.chapterProgress)).toBeCloseTo(percent, 10);
  });

  it("keeps zero-text covers navigable and estimates unknown chapter lengths from known text", () => {
    const mixed = [
      { id: "cover", characterCount: 0 },
      { id: "short", characterCount: 100 },
      { id: "unknown" },
      { id: "long", characterCount: 300 },
    ];
    expect(bookProgressPercent(mixed, "cover", 100)).toBeCloseTo(100 / 601);
    expect(bookProgressPercent(mixed, "unknown", 50)).toBeCloseTo(201 / 601 * 100);
    expect(bookProgressLocation(mixed, 0)).toEqual({ chapterId: "cover", chapterProgress: 0 });
    const unknown = bookProgressLocation(mixed, 201 / 601 * 100)!;
    expect(unknown.chapterId).toBe("unknown");
    expect(unknown.chapterProgress).toBeCloseTo(50);
  });

  it("uses equal navigable weights when all lengths are absent, zero or invalid", () => {
    const unknown = [
      { id: "a" }, { id: "b", characterCount: -1 }, { id: "c", characterCount: Number.NaN },
      { id: "d", characterCount: Number.POSITIVE_INFINITY }, { id: "e", characterCount: 0 },
    ];
    expect(bookProgressPercent(unknown, "c", 50)).toBe(50);
    expect(bookProgressLocation(unknown, 50)).toEqual({ chapterId: "c", chapterProgress: 50 });
  });

  it("maps 100 percent to the actual end of the last chapter", () => {
    expect(bookProgressLocation(chapters, 100)).toEqual({ chapterId: "long", chapterProgress: 100 });
    expect(bookProgressPercent(chapters, "long", 100)).toBe(100);
    expect(bookProgressLocation([{ id: "only", characterCount: 0 }], 100)).toEqual({ chapterId: "only", chapterProgress: 100 });
  });

  it("handles absent chapters and bounds invalid progress", () => {
    expect(bookProgressLocation([], 50)).toBeUndefined();
    expect(bookProgressPercent([], "absent", 50)).toBe(0);
    expect(bookProgressPercent(chapters, "absent", 50)).toBe(0);
    expect(bookProgressLocation(chapters, -20)).toEqual({ chapterId: "short", chapterProgress: 0 });
    expect(bookProgressLocation(chapters, 150)).toEqual({ chapterId: "long", chapterProgress: 100 });
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(bookProgressLocation(chapters, value)).toEqual({ chapterId: "short", chapterProgress: 0 });
      expect(bookProgressPercent(chapters, "short", value)).toBe(0);
    }
    expect(bookProgressPercent(chapters, "long", -1)).toBe(10);
    expect(bookProgressPercent(chapters, "long", 101)).toBe(100);
  });
});

describe("reading durations", () => {
  it.each([
    [0, "不足1分钟"], [59, "不足1分钟"], [60, "1分钟"], [3599, "59分钟"],
    [3600, "1小时"], [3661, "1小时1分钟"], [7200, "2小时"],
    [-60, "不足1分钟"], [Number.NaN, "不足1分钟"], [Number.POSITIVE_INFINITY, "不足1分钟"],
  ])("formats %s seconds as %s", (seconds, text) => {
    expect(formatReadingTime(seconds)).toBe(text);
  });

  it("estimates the remaining text at 500 characters per minute and rounds up", () => {
    expect(estimatedReadingMinutes(100_000, 0)).toBe(200);
    expect(estimatedReadingMinutes(100_000, 37)).toBe(126);
    expect(estimatedReadingMinutes(501, 0)).toBe(2);
    expect(estimatedReadingMinutes(501, 99)).toBe(1);
    expect(estimatedReadingMinutes(100_000, 100)).toBe(0);
  });

  it("keeps estimates finite when length or progress metadata is invalid", () => {
    for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(estimatedReadingMinutes(count, 25)).toBe(0);
    expect(estimatedReadingMinutes(1000, -10)).toBe(2);
    expect(estimatedReadingMinutes(1000, 110)).toBe(0);
    expect(estimatedReadingMinutes(1000, Number.NaN)).toBe(2);
  });
});
