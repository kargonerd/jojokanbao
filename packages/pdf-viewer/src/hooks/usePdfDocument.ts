import { useState, useEffect, useRef } from "react";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { resolvePdfSource, type ProtectedPdfMode } from "../protectedPdf";

GlobalWorkerOptions.workerSrc = workerUrl;

const PDFJS_VERSION = "5.7.284";
const CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const WASM_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/wasm/`;

interface UsePdfDocumentOptions {
  url: string;
  cMapUrl?: string;
  wasmUrl?: string;
  protectedPdf?: ProtectedPdfMode;
}

interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  numPages: number;
  loading: boolean;
  error: string | null;
}

export function usePdfDocument({ url, cMapUrl = CMAP_URL, wasmUrl = WASM_URL, protectedPdf = "auto" }: UsePdfDocumentOptions): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ document: null, numPages: 0, loading: true, error: null });
  const prevUrl = useRef("");

  useEffect(() => {
    if (!url || url === prevUrl.current) return;
    prevUrl.current = url;

    setState({ document: null, numPages: 0, loading: true, error: null });

    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    let abortSource: { abort: () => void } | null = null;

    const load = async () => {
      const commonParams = { cMapUrl, cMapPacked: true, wasmUrl };

      const source = await resolvePdfSource(url, protectedPdf);
      if (cancelled) {
        source.transport?.abort();
        return;
      }
      if (!source.transport) {
        throw new Error("PDF range loading requires CDN byte-range support");
      }

      abortSource = source.transport;
      task = getDocument({
        ...commonParams,
        range: source.transport,
        rangeChunkSize: 65536,
        disableStream: true,
        disableAutoFetch: true,
      });

      task.promise
        .then((doc) => {
          if (!cancelled) {
            setState({ document: doc, numPages: doc.numPages, loading: false, error: null });
          }
        })
        .catch((err) => {
          if (cancelled || String(err).includes("Worker was destroyed")) return;
          setState({ document: null, numPages: 0, loading: false, error: String(err?.message || err) });
        });
    };

    load().catch((err) => {
      if (!cancelled) {
        setState({ document: null, numPages: 0, loading: false, error: String(err?.message || err) });
      }
    });

    return () => {
      cancelled = true;
      abortSource?.abort();
      task?.destroy().catch(() => {});
    };
  }, [url, cMapUrl, wasmUrl, protectedPdf]);

  return state;
}
