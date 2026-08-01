import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePdfDocument } from "../../../packages/pdf-viewer/src/hooks/usePdfDocument";

const pdfDocumentMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  resolvePdfSource: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfDocumentMocks.getDocument,
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?worker&url", () => ({
  default: "/pdf.worker.js",
}));

vi.mock("../../../packages/pdf-viewer/src/protectedPdf", () => ({
  DEFAULT_PDF_RANGE_CHUNK_SIZE: 1_048_576,
  resolvePdfSource: pdfDocumentMocks.resolvePdfSource,
}));

interface StateSnapshot {
  url: string;
  loading: boolean;
  hasDocument: boolean;
}

function DocumentStateProbe({ url, snapshots }: { url: string; snapshots: StateSnapshot[] }) {
  const state = usePdfDocument({ url });
  snapshots.push({ url, loading: state.loading, hasDocument: Boolean(state.document) });
  return <output>{state.loading ? "loading" : state.document ? "ready" : "empty"}</output>;
}

beforeEach(() => {
  pdfDocumentMocks.getDocument.mockReset();
  pdfDocumentMocks.resolvePdfSource.mockReset().mockResolvedValue({
    kind: "buffered",
    data: new Uint8Array([1, 2, 3]),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePdfDocument route transitions", () => {
  it("returns loading synchronously instead of leaking the previous document for a new URL", async () => {
    const firstDocument = { numPages: 4, destroy: vi.fn().mockResolvedValue(undefined) };
    const firstTask = {
      promise: Promise.resolve(firstDocument),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const secondTask = {
      promise: new Promise(() => {}),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    pdfDocumentMocks.getDocument.mockReturnValueOnce(firstTask).mockReturnValueOnce(secondTask);

    const snapshots: StateSnapshot[] = [];
    const view = render(<DocumentStateProbe url="/first.pdf" snapshots={snapshots} />);
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());

    snapshots.length = 0;
    view.rerender(<DocumentStateProbe url="/second.pdf" snapshots={snapshots} />);

    expect(snapshots[0]).toEqual({ url: "/second.pdf", loading: true, hasDocument: false });
    expect(screen.getByText("loading")).toBeTruthy();
  });
});
