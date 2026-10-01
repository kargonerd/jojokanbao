// Native counterpart of frontend/web/src/archive/pdfDownloadBridge.ts. The web
// reader cannot trigger a download from inside a WebView (blob URLs and
// <a download> are ignored on Android and iOS), so it streams the decrypted
// PDF bytes over the one-way postMessage bridge in base64 chunks. This module
// validates, reassembles, and hands the file to the system share sheet.

export type PdfDownloadMessage =
  | { type: "pdf-download-start"; downloadId: string; filename: string; totalBytes: number; totalChunks: number; chunkSize?: number }
  | { type: "pdf-download-chunk"; downloadId: string; seq: number; data: string }
  | { type: "pdf-download-end"; downloadId: string }
  | { type: "pdf-download-error"; downloadId: string; message: string };

// A chunk is ~1MB of base64; anything far beyond that did not come from our bridge.
const MAX_BASE64_CHUNK_LENGTH = 4 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 120;
// A stalled transfer (page reload, WebView killed) must not leak temp files forever.
const CHUNK_TIMEOUT_MS = 60_000;

export function parsePdfDownloadMessage(value: string): PdfDownloadMessage | null {
  try {
    const message = JSON.parse(value) as Partial<PdfDownloadMessage>;
    if (typeof message.type !== "string") return null;
    const downloadId = message.downloadId;
    if (typeof downloadId !== "string" || !downloadId || downloadId.length > 64) return null;
    if (message.type === "pdf-download-start") {
      if (typeof message.filename !== "string" || !message.filename || message.filename.length > MAX_FILENAME_LENGTH) return null;
      if (!Number.isInteger(message.totalBytes) || message.totalBytes! <= 0) return null;
      if (!Number.isInteger(message.totalChunks) || message.totalChunks! <= 0) return null;
      return {
        type: "pdf-download-start",
        downloadId,
        filename: message.filename,
        totalBytes: message.totalBytes!,
        totalChunks: message.totalChunks!,
        ...(typeof message.chunkSize === "number" && Number.isInteger(message.chunkSize) ? { chunkSize: message.chunkSize } : {}),
      };
    }
    if (message.type === "pdf-download-chunk") {
      if (!Number.isInteger(message.seq) || message.seq! < 0) return null;
      if (typeof message.data !== "string" || !message.data || message.data.length > MAX_BASE64_CHUNK_LENGTH) return null;
      return { type: "pdf-download-chunk", downloadId, seq: message.seq!, data: message.data };
    }
    if (message.type === "pdf-download-end") return { type: "pdf-download-end", downloadId };
    if (message.type === "pdf-download-error" && typeof message.message === "string") {
      return { type: "pdf-download-error", downloadId, message: message.message.slice(0, 300) };
    }
  } catch {
    // Download messages are optional; malformed values fall through to the
    // regular reader bridge parsing.
  }
  return null;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeFilename(filename: string, downloadId: string): string {
  const sanitized = filename.replace(/[^\w.\-()（）]/g, "_").replace(/^\.+/, "");
  return sanitized.endsWith(".pdf") ? sanitized : `${sanitized || downloadId}.pdf`;
}

interface PdfDownloadSession {
  downloadId: string;
  filename: string;
  totalBytes: number;
  totalChunks: number;
  chunks: Uint8Array[];
  receivedBytes: number;
}

export class PdfDownloadAssembler {
  private session: PdfDownloadSession | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private finishing = false;

  handle(message: PdfDownloadMessage): void {
    if (message.type === "pdf-download-start") {
      this.begin(message);
    } else if (message.type === "pdf-download-chunk") {
      this.acceptChunk(message);
    } else if (message.type === "pdf-download-end") {
      void this.finish(message.downloadId);
    } else {
      this.reset();
    }
  }

  dispose(): void {
    this.reset();
  }

  private begin(message: Extract<PdfDownloadMessage, { type: "pdf-download-start" }>): void {
    // A fresh start replaces any stalled previous session.
    this.reset();
    this.session = {
      downloadId: message.downloadId,
      filename: message.filename,
      totalBytes: message.totalBytes,
      totalChunks: message.totalChunks,
      chunks: [],
      receivedBytes: 0,
    };
    this.armTimeout();
  }

  private acceptChunk(message: Extract<PdfDownloadMessage, { type: "pdf-download-chunk" }>): void {
    const session = this.session;
    if (!session || this.finishing || message.downloadId !== session.downloadId) return;
    // Strictly ordered: out-of-order or duplicate chunks mean the web side
    // restarted or messages were duplicated; drop the session instead of
    // writing a corrupt PDF.
    if (message.seq !== session.chunks.length) {
      this.reset();
      return;
    }
    const bytes = base64ToBytes(message.data);
    session.chunks.push(bytes);
    session.receivedBytes += bytes.length;
    if (session.receivedBytes > session.totalBytes) {
      this.reset();
      return;
    }
    this.armTimeout();
  }

  private async finish(downloadId: string): Promise<void> {
    const session = this.session;
    if (!session || this.finishing || downloadId !== session.downloadId) return;
    if (session.chunks.length !== session.totalChunks || session.receivedBytes !== session.totalBytes) {
      this.reset();
      return;
    }
    this.finishing = true;
    this.disarmTimeout();
    const { File, Directory, Paths } = await import("expo-file-system");
    const Sharing = await import("expo-sharing");
    try {
      const bytes = new Uint8Array(session.totalBytes);
      let offset = 0;
      for (const chunk of session.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const directory = new Directory(Paths.cache, "pdf-share");
      directory.create({ idempotent: true, intermediates: true });
      const file = new File(directory, safeFilename(session.filename, session.downloadId));
      file.write(bytes);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: session.filename });
      }
      if (file.exists) file.delete();
    } catch {
      // The share sheet is best effort; never surface native errors from a
      // background message handler.
    } finally {
      this.finishing = false;
      this.session = null;
    }
  }

  private armTimeout(): void {
    this.disarmTimeout();
    this.timeout = setTimeout(() => this.reset(), CHUNK_TIMEOUT_MS);
  }

  private disarmTimeout(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private reset(): void {
    this.disarmTimeout();
    this.session = null;
  }
}
