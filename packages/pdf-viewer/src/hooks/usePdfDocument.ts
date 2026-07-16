import { useState, useEffect } from "react";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  DEFAULT_PDF_RANGE_CHUNK_SIZE,
  resolvePdfSource,
  type ProtectedPdfMode,
} from "../protectedPdf";

GlobalWorkerOptions.workerSrc = workerUrl;

const PDFJS_VERSION = "5.7.284";
const CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const WASM_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/wasm/`;

interface UsePdfDocumentOptions {
  url: string;
  cMapUrl?: string;
  wasmUrl?: string;
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
  protectedPdf = "auto",
  rangeChunkSize = DEFAULT_PDF_RANGE_CHUNK_SIZE,
}: UsePdfDocumentOptions): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ document: null, numPages: 0, loading: true, error: null });

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

    const fail = (error: unknown) => {
      if (cancelled || failed) return;
      failed = true;
      abortSource?.abort();
      void task?.destroy().catch(() => {});
      setState({ document: null, numPages: 0, loading: false, error: errorMessage(error) });
    };

    const load = async () => {
      const commonParams = {
        cMapUrl,
        cMapPacked: true,
        wasmUrl,
        isEvalSupported: false,
      };

      const source = await resolvePdfSource(url, protectedPdf, {
        rangeChunkSize,
        onRangeError: fail,
      });
      if (cancelled) {
        source.transport.abort();
        return;
      }

      abortSource = source.transport;
      task = getDocument({
        ...commonParams,
        range: source.transport,
        rangeChunkSize,
        disableRange: false,
        disableStream: true,
        disableAutoFetch: true,
      });

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
      abortSource?.abort();
      task?.destroy().catch(() => {});
    };
  }, [url, cMapUrl, wasmUrl, protectedPdf, rangeChunkSize]);

  return state;
}
