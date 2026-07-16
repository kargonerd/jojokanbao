import { describe, it, expect, vi } from "vitest";

vi.mock("@jojo/pdf-viewer", () => ({
  fetchPdfDownloadBytes: vi.fn(),
  PdfPage: () => null,
  PdfViewer: () => null,
  usePdfDocument: () => ({ document: null, numPages: 0, loading: false, error: null }),
}));

describe("Reader App", () => {
  it("smoke test - app module loads", async () => {
    const mod = await import("../src/App");
    expect(mod.App).toBeDefined();
  });
});
