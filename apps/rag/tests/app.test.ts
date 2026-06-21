import { describe, it, expect } from "vitest";

describe("RAG App", () => {
  it("smoke test - app module loads", async () => {
    const mod = await import("../src/App");
    expect(mod.App).toBeDefined();
  });

  it("normalizes chapter payloads returned by the catalog API", async () => {
    const mod = await import("../src/pages/ReaderPage");

    expect(mod.resolveChapterText("plain markdown")).toBe("plain markdown");
    expect(mod.resolveChapterText({ text: "# Chapter\n\nBody" })).toBe("# Chapter\n\nBody");
    expect(mod.resolveChapterText({})).toBe("");
  });
});
