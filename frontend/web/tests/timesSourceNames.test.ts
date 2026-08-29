import { describe, expect, it } from "vitest";
import { timesSourceName } from "../src/times/sourceNames";

describe("Times source display names", () => {
  it("uses the familiar Chinese name for South China Morning Post", () => {
    expect(timesSourceName({ id: "scmp", name: "South China Morning Post" })).toBe("南华早报");
  });

  it("keeps the delivery name for sources without an alias", () => {
    expect(timesSourceName({ id: "ap", name: "AP News" })).toBe("AP News");
  });
});
