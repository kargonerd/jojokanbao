import { describe, it, expect } from "vitest";

describe("RAG App", () => {
  it("smoke test - app module loads", async () => {
    const mod = await import("../src/App");
    expect(mod.App).toBeDefined();
  });
});
