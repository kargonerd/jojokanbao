import { describe, expect, it } from "vitest";
import {
  archivePdfUrl,
  archiveWebIssueUrl,
  dateToIssueId,
  formatArchiveIssueLabel,
  getLatestRmrbAvailableDate,
  isArchiveNewspaperIssueAvailable,
  isArchiveIssueId,
  issueIdToDate,
  stripSearchHighlights,
} from "../src/archive";

describe("archive shared domain", () => {
  it("builds revisioned protected-PDF and reader URLs", () => {
    expect(archivePdfUrl("rmrb", "20260521")).toBe(
      "https://blacknews.jojokanbao.cn/RMRB/2026/20260521-r1.pdf",
    );
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
