import { describe, expect, it } from "vitest";
import { publisherUpdatedAt } from "../src/times/articleTime";

describe("Times publisher update time", () => {
  it("returns only a valid publisher time later than the original publication", () => {
    expect(publisherUpdatedAt({
      publishedAt: "2026-09-02T14:12:37.000Z",
      updatedAt: "2026-09-02T14:43:57.000Z",
    })).toBe("2026-09-02T14:43:57.000Z");
    expect(publisherUpdatedAt({
      publishedAt: "2026-09-02T14:12:37.000Z",
      updatedAt: "2026-09-02T14:12:37.000Z",
    })).toBeUndefined();
    expect(publisherUpdatedAt({
      publishedAt: "2026-09-02T14:12:37.000Z",
      updatedAt: "invalid",
    })).toBeUndefined();
  });
});
