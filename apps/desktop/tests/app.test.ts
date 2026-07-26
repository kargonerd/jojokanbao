import { describe, it, expect, vi } from "vitest";

vi.mock("@jojo/pdf-viewer", () => ({
  PdfPage: () => null,
  PdfViewer: () => null,
  usePdfDocument: () => ({ document: null, numPages: 0, loading: false, error: null }),
}));

describe("Press App", () => {
  it("smoke test - app module loads", async () => {
    const mod = await import("../src/App");
    expect(mod.App).toBeDefined();
  });
});
