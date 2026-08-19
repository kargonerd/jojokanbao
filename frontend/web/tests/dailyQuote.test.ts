import { describe, expect, it } from "vitest";
import { DAILY_QUOTES, dailyQuote } from "../src/home/dailyQuote";

describe("dailyQuote", () => {
  it("stays stable for the same Shanghai calendar day", () => {
    const beforeMidnightUtc = new Date("2026-08-14T16:01:00.000Z");
    const laterThatDay = new Date("2026-08-15T15:59:00.000Z");
    expect(dailyQuote(beforeMidnightUtc)).toEqual(dailyQuote(laterThatDay));
  });

  it("rotates on the next Shanghai calendar day", () => {
    const first = dailyQuote(new Date("2026-08-15T15:59:59.000Z"));
    const next = dailyQuote(new Date("2026-08-15T16:00:00.000Z"));
    expect(first).not.toEqual(next);
    expect(DAILY_QUOTES).toContainEqual(first);
    expect(DAILY_QUOTES).toContainEqual(next);
  });

  it("uses only sourced quotations by Mao Zedong", () => {
    expect(DAILY_QUOTES).toHaveLength(12);
    expect(DAILY_QUOTES.every((quote) => quote.source.startsWith("毛泽东《"))).toBe(true);
  });
});
