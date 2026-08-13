import { describe, expect, it } from "vitest";
import { phraseKey } from "../src/rag/readerData";

describe("reader data anchors", () => {
  it("normalizes equivalent explanation phrases without changing content", () => {
    expect(phraseKey("  ＡＢＣ　革命  ")).toBe("abc 革命");
  });
});
