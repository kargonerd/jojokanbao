import { describe, expect, it } from "vitest";
import {
  readerReturnPathFromState,
  readerReturnState,
  safeReaderReturnPath,
  withReaderReturnTo,
} from "../src/rag/readerNavigation";

describe("reader navigation", () => {
  it("keeps a safe in-app source path on reader links", () => {
    expect(withReaderReturnTo("/book/mao/volume-1?chapter=1", "/bookshelf?sort=recent")).toBe(
      "/book/mao/volume-1?chapter=1&returnTo=%2Fbookshelf%3Fsort%3Drecent",
    );
    expect(readerReturnPathFromState(readerReturnState("/rag?book=mao"))).toBe("/rag?book=mao");
  });

  it("rejects external or malformed return locations", () => {
    expect(safeReaderReturnPath("//evil.example")).toBe("/library?type=book");
    expect(safeReaderReturnPath("/\\evil.example")).toBe("/library?type=book");
    expect(safeReaderReturnPath("https://evil.example")).toBe("/library?type=book");
  });
});
