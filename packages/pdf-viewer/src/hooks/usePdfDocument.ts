import { useState, useEffect } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?worker&url";
import {
  DEFAULT_PDF_RANGE_CHUNK_SIZE,
  resolvePdfSource,
  type ProtectedPdfMode,
} from "../protectedPdf";

GlobalWorkerOptions.workerSrc = workerUrl;

const CMAP_URL = "/assets/pdfjs/cmaps/";
const WASM_URL = "/assets/pdfjs/wasm/";
const STANDARD_FONT_URL = "/assets/pdfjs/standard_fonts/";

interface UsePdfDocumentOptions {
  url: string;
  cMapUrl?: string;
  wasmUrl?: string;
  standardFontDataUrl?: string;
  protectedPdf?: ProtectedPdfMode;
  rangeChunkSize?: number;
}

interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  numPages: number;
  loading: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePdfDocument({
  url,
  cMapUrl = CMAP_URL,
  wasmUrl = WASM_URL,
  standardFontDataUrl = STANDARD_FONT_URL,
  protectedPdf = "auto",
  rangeChunkSize = DEFAULT_PDF_RANGE_CHUNK_SIZE,
}: UsePdfDocumentOptions): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ document: null, numPages: 0, loading: Boolean(url), error: null });

  useEffect(() => {
    if (!url) {
      setState({ document: null, numPages: 0, loading: false, error: null });
      return;
    }

    setState({ document: null, numPages: 0, loading: true, error: null });

    let cancelled = false;
    let failed = false;
    let task: PDFDocumentLoadingTask | null = null;
    let abortSource: { abort: () => void } | null = null;
    const initialRequest = new AbortController();

    const fail = (error: unknown) => {
      if (cancelled || failed) return;
      failed = true;
      initialRequest.abort();
      abortSource?.abort();
      void task?.destroy().catch(() => {});
      setState({ document: null, numPages: 0, loading: false, error: errorMessage(error) });
    };

    const load = async () => {
      const commonParams = {
        cMapUrl,
        cMapPacked: true,
        wasmUrl,
        standardFontDataUrl,
        isEvalSupported: false,
      };

      const source = await resolvePdfSource(url, protectedPdf, {
        rangeChunkSize,
        onRangeError: fail,
      }, initialRequest.signal);
      if (cancelled) {
        if (source.kind !== "buffered") source.transport.abort();
        return;
      }

      if (source.kind === "buffered") {
        task = getDocument({ ...commonParams, data: source.data });
      } else {
        abortSource = source.transport;
        task = getDocument({
          ...commonParams,
          range: source.transport,
          rangeChunkSize,
          disableRange: false,
          disableStream: true,
          disableAutoFetch: true,
        });
      }

      const doc = await task.promise;
      if (cancelled || failed) {
        await doc.destroy().catch(() => {});
        return;
      }
      setState({ document: doc, numPages: doc.numPages, loading: false, error: null });
    };

    void load().catch(fail);

    return () => {
      cancelled = true;
      initialRequest.abort();
      abortSource?.abort();
      task?.destroy().catch(() => {});
    };
  }, [url, cMapUrl, wasmUrl, standardFontDataUrl, protectedPdf, rangeChunkSize]);

  return state;
}
