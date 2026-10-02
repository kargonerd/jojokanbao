import { describe, expect, it } from "vitest";
import {
  archiveWebIssueUrl,
  dateToIssueId,
  formatArchiveIssueLabel,
  getLatestRmrbAvailableDate,
  isArchiveNewspaperIssueAvailable,
  isArchiveIssueId,
  isAdaptiveCalendarDateAvailable,
  issueIdToDate,
  stripSearchHighlights,
} from "../src/archive";
import type { JojoAdaptiveCalendar } from "../src/types";

describe("archive shared domain", () => {
  it("builds reader URLs", () => {
    expect(archiveWebIssueUrl("rmrb", "19660701", 5)).toBe(
      "https://reader.jojokanbao.cn/archive/rmrb/19660701#page-5",
    );
  });

  it("formats and validates newspaper and magazine issues", () => {
    expect(formatArchiveIssueLabel("19761009")).toBe("1976 年 10 月 9 日");
    expect(formatArchiveIssueLabel("197292")).toBe("1972 年增刊 2");
    expect(isArchiveIssueId("rmrb", "19761009")).toBe(true);
    expect(isArchiveIssueId("hq", "196419")).toBe(true);
    expect(isArchiveIssueId("hq", "19641009")).toBe(false);
  });

  it("uses the China-time archive publication cutoff", () => {
    expect(getLatestRmrbAvailableDate(new Date("2026-07-17T10:59:00Z"))).toBe("20260716");
    expect(getLatestRmrbAvailableDate(new Date("2026-07-17T11:00:00Z"))).toBe("20260717");
  });

  it("round trips local calendar dates and strips search markers", () => {
    const date = issueIdToDate("19660701");
    expect(dateToIssueId(date)).toBe("19660701");
    expect(stripSearchHighlights("革命@highlight@历史@/highlight@文献")).toBe("革命历史文献");
  });

  it("rejects known newspaper archive gaps and invalid calendar dates", () => {
    const afterCutoff = new Date("2026-08-21T12:00:00Z");
    expect(isArchiveNewspaperIssueAvailable("rmrb", "19460515", afterCutoff)).toBe(true);
    expect(isArchiveNewspaperIssueAvailable("rmrb", "20030418", afterCutoff)).toBe(false);
    expect(isArchiveNewspaperIssueAvailable("rmrb", "20260822", afterCutoff)).toBe(false);
    expect(isArchiveNewspaperIssueAvailable("ckxx", "19630315", afterCutoff)).toBe(false);
    expect(isArchiveNewspaperIssueAvailable("ckxx", "19630329", afterCutoff)).toBe(true);
    expect(isArchiveNewspaperIssueAvailable("ckxx", "19890601", afterCutoff)).toBe(false);
    expect(isArchiveNewspaperIssueAvailable("ckxx", "19900102", afterCutoff)).toBe(true);
    expect(isArchiveNewspaperIssueAvailable("ckxx", "19990229", afterCutoff)).toBe(false);
  });
});

describe("adaptive calendar availability", () => {
  // Fixture mirrors the published rmrb/ckxx calendars: default available,
  // per-year excludes as dates/ranges/months, and an empty include year.
  const calendar: JojoAdaptiveCalendar = {
    format: "adaptive-calendar/1",
    startDate: "1957-03-01",
    endDate: "1998-12-31",
    default: "available",
    years: {
      "1957": { exclude: { dates: ["05-02"], ranges: [["08-25", "08-31"]] } },
      "1958": { exclude: { months: ["02"] } },
      "1989": { include: {} },
    },
  };

  it("applies the published start and end boundaries", () => {
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570228")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570301")).toBe(true);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19981231")).toBe(true);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19990101")).toBe(false);
  });

  it("supports exclude dates, ranges, and whole months", () => {
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570502")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570503")).toBe(true);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570825")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570831")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19570901")).toBe(true);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19580210")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19580301")).toBe(true);
  });

  it("treats an empty include year as fully unavailable", () => {
    expect(isAdaptiveCalendarDateAvailable(calendar, "19890101")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "19891231")).toBe(false);
  });

  it("rejects malformed issue ids", () => {
    expect(isAdaptiveCalendarDateAvailable(calendar, "1957030")).toBe(false);
    expect(isAdaptiveCalendarDateAvailable(calendar, "not-a-date")).toBe(false);
  });
});
