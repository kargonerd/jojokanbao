import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLICATIONS } from "../src/publications";
import { getLatestRmrbAvailableDate, RMRB_DAILY_AVAILABLE_HOUR } from "../src/dateAvailability";

afterEach(() => {
  vi.useRealTimers();
});

describe("publication catalog invariants", () => {
  it("keeps all five route keys, labels, types, and defaults stable", () => {
    expect(Object.entries(PUBLICATIONS).map(([key, publication]) => ({
      key,
      label: publication.label,
      type: publication.type,
      defaultId: publication.defaultId,
    }))).toEqual([
      { key: "rmrb", label: "人民日报", type: "newspaper", defaultId: "19761009" },
      { key: "ckxx", label: "参考消息", type: "newspaper", defaultId: "19760910" },
      { key: "hq", label: "红旗", type: "magazine", defaultId: "196419" },
      { key: "rmhb", label: "人民画报", type: "magazine", defaultId: "197292" },
      { key: "sjzs", label: "世界知识", type: "magazine", defaultId: "196513" },
    ]);
  });

  it("keeps every configured issue list sorted, unique, and positive", () => {
    for (const publication of Object.values(PUBLICATIONS)) {
      for (const [year, issues] of Object.entries(publication.seqConfig ?? {})) {
        expect(issues, `${publication.name} ${year} must not contain duplicates`).toEqual([...new Set(issues)]);
        expect(issues, `${publication.name} ${year} must be sorted`).toEqual([...issues].sort((a, b) => a - b));
        expect(issues.every((issue) => Number.isInteger(issue) && issue > 0)).toBe(true);
      }
    }
  });

  it("keeps every default route inside its publication availability", () => {
    for (const publication of Object.values(PUBLICATIONS)) {
      if (publication.type === "newspaper") {
        expect(publication.disabledDate?.(publication.defaultId)).toBe(false);
        continue;
      }
      const year = publication.defaultId.slice(0, 4);
      const issue = Number(publication.defaultId.slice(4));
      expect(publication.seqConfig?.[year]).toContain(issue);
    }
  });

  it("exposes clarity control only for the high-resolution newspaper", () => {
    expect(PUBLICATIONS.rmrb?.resolutionControl).toBe(true);
    expect(Object.values(PUBLICATIONS).filter((publication) => publication.resolutionControl).map((publication) => publication.name))
      .toEqual(["rmrb"]);
  });
});

describe("人民日报 availability", () => {
  const disabled = PUBLICATIONS.rmrb!.disabledDate!;

  it.each([
    ["19460514", true],
    ["19460515", false],
  ])("applies the archive boundary for %s", (date, expected) => {
    expect(disabled(date)).toBe(expected);
  });

  it("exposes today's issue only after the daily sync completion window", () => {
    expect(RMRB_DAILY_AVAILABLE_HOUR).toBe(19);
    expect(getLatestRmrbAvailableDate(new Date("2026-07-17T10:59:59Z"))).toBe("20260716");
    expect(getLatestRmrbAvailableDate(new Date("2026-07-17T11:00:00Z"))).toBe("20260717");
    expect(getLatestRmrbAvailableDate(new Date("2026-01-01T02:00:00Z"))).toBe("20251231");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-17T10:59:59Z"));
    expect(disabled("20260716")).toBe(false);
    expect(disabled("20260717")).toBe(true);

    vi.setSystemTime(new Date("2026-07-17T11:00:00Z"));
    expect(disabled("20260717")).toBe(false);
    expect(disabled("20260718")).toBe(true);
  });

  it("blocks missing years without blocking adjacent archived years", () => {
    expect(disabled("19990701")).toBe(true);
    expect(disabled("20050701")).toBe(true);
    expect(disabled("19980701")).toBe(false);
    expect(disabled("20080701")).toBe(false);
  });

  it("blocks known missing runs and permits the next available issue", () => {
    expect(disabled("19460628")).toBe(true);
    expect(disabled("19460630")).toBe(true);
    expect(disabled("19460701")).toBe(false);
    expect(disabled("20100620")).toBe(true);
    expect(disabled("20100701")).toBe(false);
  });
});

describe("参考消息 availability", () => {
  const disabled = PUBLICATIONS.ckxx!.disabledDate!;

  it.each([
    ["19570228", true],
    ["19570301", false],
    ["19981231", false],
    ["19990101", true],
  ])("applies the archive boundary for %s", (date, expected) => {
    expect(disabled(date)).toBe(expected);
  });

  it("blocks the excluded 1989 archive year", () => {
    expect(disabled("19890101")).toBe(true);
    expect(disabled("19891231")).toBe(true);
    expect(disabled("19881231")).toBe(false);
    expect(disabled("19900102")).toBe(false);
  });

  it("preserves individual blacklist gaps", () => {
    expect(disabled("19580707")).toBe(true);
    expect(disabled("19580708")).toBe(false);
    expect(disabled("19960224")).toBe(true);
    expect(disabled("19960225")).toBe(false);
  });
});

describe("magazine issue availability", () => {
  it("keeps 红旗 regular issues and supplement labels", () => {
    const hq = PUBLICATIONS.hq!;
    expect(hq.seqConfig?.["1964"]).toEqual([...Array.from({ length: 24 }, (_, index) => index + 1), 91, 92]);
    expect(hq.seqConfig?.["1965"]).toEqual([...Array.from({ length: 13 }, (_, index) => index + 1), 91]);
    expect(hq.genSeqText?.(19)).toBe("第19期");
    expect(hq.genSeqText?.(91)).toBe("增刊1");
    expect(hq.genSeqText?.(92)).toBe("增刊2");
  });

  it("keeps 人民画报 missing years/issues and supplement issues", () => {
    const rmhb = PUBLICATIONS.rmhb!;
    expect(rmhb.disabledDate?.("19491231")).toBe(true);
    expect(rmhb.disabledDate?.("19500101")).toBe(false);
    expect(rmhb.disabledDate?.("19750101")).toBe(true);
    expect(rmhb.disabledDate?.("19760101")).toBe(false);
    expect(rmhb.seqConfig?.["1972"]).not.toContain(11);
    expect(rmhb.seqConfig?.["1972"]).toEqual(expect.arrayContaining([91, 92, 93, 94]));
    expect(rmhb.seqConfig?.["1976"]).not.toContain(7);
    expect(rmhb.seqConfig?.["1976"]).toContain(91);
  });

  it("keeps 世界知识 archive year gaps", () => {
    const disabled = PUBLICATIONS.sjzs!.disabledDate!;
    expect(disabled("19330101")).toBe(true);
    expect(disabled("19340101")).toBe(false);
    expect(disabled("19420101")).toBe(true);
    expect(disabled("19450101")).toBe(false);
    expect(disabled("19670101")).toBe(true);
    expect(disabled("19780101")).toBe(false);
    expect(disabled("20250101")).toBe(false);
    expect(disabled("20260101")).toBe(true);
  });

  it("keeps 世界知识 historical issue gaps", () => {
    const issues = PUBLICATIONS.sjzs!.seqConfig!;
    expect(issues["1940"]).not.toContain(5);
    expect(issues["1940"]).not.toContain(6);
    expect(issues["1941"]).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(issues["1946"]).not.toContain(4);
    expect(issues["1951"]).not.toContain(34);
    expect(issues["2009"]).not.toContain(6);
    expect(issues["2025"]).not.toContain(13);
  });
});
