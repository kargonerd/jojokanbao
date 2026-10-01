// The native mobile app renders the web reader inside a WebView, where blob
// URLs and <a download> never trigger a save. Instead of a blob, the decrypted
// PDF bytes are handed to the native shell through the existing one-way
// postMessage bridge; the native side reassembles them and opens the system
// share sheet (see frontend/mobile/src/lib/pdfDownloadReceive.ts).

export const NATIVE_PDF_DOWNLOAD_MAX_BYTES = 150 * 1024 * 1024;
const CHUNK_BYTES = 768 * 1024;
const APPLY_SLICE_BYTES = 0x8000;

interface NativeWebView {
  postMessage: (data: string) => void;
}

function nativeWebView(): NativeWebView | null {
  if (typeof window === "undefined") return null;
  const native = (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  return native && typeof (native as NativeWebView).postMessage === "function"
    ? native as NativeWebView
    : null;
}

export function isNativeReader(): boolean {
  if (typeof window === "undefined") return false;
  return nativeWebView() !== null
    || "__jojoNativeReaderBridge" in window
    || /JOJOKanbaoMobile\//i.test(navigator.userAgent);
}

function bytesToBase64(bytes: Uint8Array, start: number, end: number): string {
  let binary = "";
  for (let offset = start; offset < end; offset += APPLY_SLICE_BYTES) {
    binary += String.fromCharCode.apply(null, [
      ...bytes.subarray(offset, Math.min(offset + APPLY_SLICE_BYTES, end)),
    ] as unknown as number[]);
  }
  return btoa(binary);
}

// Large issues take a few seconds to base64-encode; yield between chunks so
// the WebView keeps painting the download progress instead of freezing.
async function yieldToFrame(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

export async function postPdfDownloadToNative(bytes: Uint8Array, filename: string): Promise<void> {
  const native = nativeWebView();
  if (!native) throw new Error("当前不在客户端阅读器中，无法直接保存");
  if (bytes.length > NATIVE_PDF_DOWNLOAD_MAX_BYTES) {
    throw new Error("文件过大，请复制链接在浏览器中打开后下载");
  }

  const downloadId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  const post = (message: Record<string, unknown>) => native.postMessage(JSON.stringify(message));

  post({
    type: "pdf-download-start",
    downloadId,
    filename,
    totalBytes: bytes.length,
    totalChunks,
    chunkSize: CHUNK_BYTES,
  });
  for (let seq = 0; seq < totalChunks; seq += 1) {
    const start = seq * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, bytes.length);
    post({ type: "pdf-download-chunk", downloadId, seq, data: bytesToBase64(bytes, start, end) });
    if (seq + 1 < totalChunks) await yieldToFrame();
  }
  post({ type: "pdf-download-end", downloadId });
}
