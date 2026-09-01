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

  it("uses only sourced quotations", () => {
    expect(DAILY_QUOTES).toHaveLength(17);
    expect(DAILY_QUOTES.every((quote) => quote.source.includes("《"))).toBe(true);
    expect(DAILY_QUOTES).toContainEqual({
      text: "人最宝贵的是生命。生命对于每个人只有一次。",
      source: "保尔·柯察金《钢铁是怎样炼成的》",
    });
    expect(DAILY_QUOTES).toContainEqual({
      text: "其实地上本没有路，走的人多了，也便成了路。",
      source: "鲁迅《故乡》",
    });
    expect(DAILY_QUOTES).toContainEqual({
      text: "横眉冷对千夫指，俯首甘为孺子牛。",
      source: "鲁迅《自嘲》",
    });
    expect(DAILY_QUOTES).toContainEqual({
      text: "不在沉默中爆发，就在沉默中灭亡。",
      source: "鲁迅《记念刘和珍君》",
    });
    expect(DAILY_QUOTES).toContainEqual({
      text: "愿中国青年都摆脱冷气，只是向上走，不必听自暴自弃者流的话。能做事的做事，能发声的发声。有一分热，发一分光。就令萤火一般，也可以在黑暗里发一点光，不必等候炬火。",
      source: "鲁迅《热风·随感录四十一》",
    });
  });
});
