import { useState, useEffect, useRef } from "react";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const PDFJS_VERSION = "5.7.284";
const CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const WASM_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/wasm/`;

interface UsePdfDocumentOptions {
  url: string;
  cMapUrl?: string;
  wasmUrl?: string;
}

interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  numPages: number;
  loading: boolean;
  error: string | null;
}

export function usePdfDocument({ url, cMapUrl = CMAP_URL, wasmUrl = WASM_URL }: UsePdfDocumentOptions): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ document: null, numPages: 0, loading: true, error: null });
  const prevUrl = useRef("");

  useEffect(() => {
    if (!url || url === prevUrl.current) return;
    prevUrl.current = url;

    setState({ document: null, numPages: 0, loading: true, error: null });

    const task = getDocument({ url, cMapUrl, cMapPacked: true, wasmUrl });

    task.promise
      .then((doc) => {
        setState({ document: doc, numPages: doc.numPages, loading: false, error: null });
      })
      .catch((err) => {
        if (String(err).includes("Worker was destroyed")) return;
        setState({ document: null, numPages: 0, loading: false, error: String(err?.message || err) });
      });

    return () => { task.destroy().catch(() => {}); };
  }, [url, cMapUrl, wasmUrl]);

  return state;
}
