import { describe, expect, it } from "vitest";
import { PUBLICATIONS } from "../src/archive/publications";
import { yearSeqMapFromItemKeys } from "../src/archive/useArchiveIssueOptions";

describe("publication catalog invariants", () => {
  it("keeps all five route keys, labels, types, and defaults stable", () => {
    expect(Object.entries(PUBLICATIONS).map(([key, publication]) => ({
      key,
      label: publication.label,
      type: publication.type,
      defaultId: publication.defaultId,
    }))).toEqual([
      { key: "rmrb", label: "人民日报", type: "newspaper", defaultId: "19760910" },
      { key: "ckxx", label: "参考消息", type: "newspaper", defaultId: "19760910" },
      { key: "hq", label: "红旗", type: "magazine", defaultId: "196419" },
      { key: "rmhb", label: "人民画报", type: "magazine", defaultId: "197292" },
      { key: "sjzs", label: "世界知识", type: "magazine", defaultId: "196513" },
    ]);
  });

  it("defers availability to the Delivery data layer", () => {
    // 期数表与缺档黑名单已全部删除：杂志由数据集索引枚举期次，
    // 报纸由索引中的自适应日历判定日期。默认期是否可读由数据层校验。
    for (const publication of Object.values(PUBLICATIONS)) {
      expect("seqConfig" in publication, `${publication.name} must not carry a local issue table`).toBe(false);
      expect("disabledDate" in publication, `${publication.name} must not carry a local date blacklist`).toBe(false);
    }
  });

  it("exposes clarity control only for the high-resolution newspaper", () => {
    expect(PUBLICATIONS.rmrb?.resolutionControl).toBe(true);
    expect(Object.values(PUBLICATIONS).filter((publication) => publication.resolutionControl).map((publication) => publication.name))
      .toEqual(["rmrb"]);
  });
});

describe("人民日报 configuration", () => {
  it("loads page outlines only for years that contain edition-level bookmarks", () => {
    const available = PUBLICATIONS.rmrb!.pageOutlineAvailable!;
    expect(available("19460515")).toBe(true);
    expect(available("19480101")).toBe(false);
    expect(available("19490101")).toBe(true);
    expect(available("20071231")).toBe(true);
    expect(available("20080101")).toBe(false);
    expect(available("20100101")).toBe(false);
    expect(available("20110326")).toBe(true);
    expect(available("20120101")).toBe(true);
    expect(available("20140111")).toBe(false);
    expect(available("20260718")).toBe(false);
  });
});

describe("magazine issue availability", () => {
  it("keeps 红旗 supplement labels", () => {
    const hq = PUBLICATIONS.hq!;
    expect("seqConfig" in hq).toBe(false);
    expect("disabledDate" in hq).toBe(false);
    expect(hq.genSeqText?.(19)).toBe("第19期");
    expect(hq.genSeqText?.(91)).toBe("增刊1");
    expect(hq.genSeqText?.(92)).toBe("增刊2");
  });

  it("derives 红旗 year issue lists from Delivery item keys", () => {
    const itemKeys = [
      "195801", "195814",
      "196401", "196419", "196424", "196491", "196492",
      "197612",
      "197701", "197712",
      "198001", "198024",
      "198601", "198618", "198620", "198624",
      "198801", "198812",
    ];
    const map = yearSeqMapFromItemKeys(itemKeys);
    expect(Object.keys(map)).toEqual([
      "1958", "1964", "1976", "1977", "1980", "1986", "1988",
    ]);
    expect(map["1964"]).toEqual([1, 19, 24, 91, 92]);
    expect(map["1977"]).toEqual([1, 12]);
    expect(map["1986"]).toEqual([1, 18, 20, 24]);
    expect(map["1986"]).not.toContain(19);
    expect(map["1988"]).toEqual([1, 12]);
  });

  it("ignores non-magazine item keys when deriving issue lists", () => {
    expect(yearSeqMapFromItemKeys(["rmrb:19760910", "19760910", "abc123", "196419"])).toEqual({
      "1964": [19],
    });
  });

  it("derives 人民画报 and 世界知识 issue lists the same way", () => {
    const rmhbMap = yearSeqMapFromItemKeys([
      "195007", "195012", "197211", "197212", "197691",
      "197501",
    ]);
    expect(rmhbMap["1950"]).toEqual([7, 12]);
    expect(rmhbMap["1972"]).toEqual([11, 12]);
    expect(rmhbMap["1976"]).toEqual([91]);
    expect(rmhbMap["1975"]).toEqual([1]);

    const sjzsMap = yearSeqMapFromItemKeys([
      "194001", "194004", "194007", "194101", "194115",
      "194501", "194512",
    ]);
    expect(sjzsMap["1940"]).toEqual([1, 4, 7]);
    expect(sjzsMap["1941"]).toEqual([1, 15]);
    expect(sjzsMap["1945"]).toEqual([1, 12]);
  });
});
