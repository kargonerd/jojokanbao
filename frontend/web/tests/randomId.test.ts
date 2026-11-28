import { describe, expect, it } from "vitest";
import { randomId } from "../src/lib/randomId";

describe("randomId", () => {
  it("生成固定长度的十六进制 id", () => {
    expect(randomId()).toMatch(/^[0-9a-f]{24}$/);
    expect(randomId(8)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("连续调用不重复", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
  });
});
