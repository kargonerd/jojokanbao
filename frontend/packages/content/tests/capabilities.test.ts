import { describe, expect, it } from "vitest";
import { supportsJojoDatasetAi } from "../src";

describe("Dataset AI capability", () => {
  it("requires an explicit true value", () => {
    expect(supportsJojoDatasetAi({ aiEnabled: true })).toBe(true);
    expect(supportsJojoDatasetAi({ aiEnabled: false })).toBe(false);
    expect(supportsJojoDatasetAi({})).toBe(false);
  });
});
