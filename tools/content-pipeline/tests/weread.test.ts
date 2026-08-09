import { describe, expect, it } from "vitest";
import { decodeWereadParts, hashWereadId } from "../src";

describe("WeRead transport decoder", () => {
  it("decodes a minimally wrapped Base64 payload", () => {
    expect(decodeWereadParts([`${"A".repeat(32)}xSGk`])).toBe("Hi");
  });

  it("generates the cid used by WeRead chapter responses", () => {
    expect(hashWereadId(36)).toBe("19c3222022419ca14e7eef7");
  });
});
