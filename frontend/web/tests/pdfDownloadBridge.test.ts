import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_PDF_DOWNLOAD_MAX_BYTES,
  isNativeReader,
  postPdfDownloadToNative,
} from "../src/archive/pdfDownloadBridge";

const CHUNK_BYTES = 768 * 1024;

interface PostedMessage {
  type: string;
  downloadId?: string;
  filename?: string;
  totalBytes?: number;
  totalChunks?: number;
  chunkSize?: number;
  seq?: number;
  data?: string;
  message?: string;
}

function capturePostMessages(): PostedMessage[] {
  const posted: PostedMessage[] = [];
  vi.stubGlobal("ReactNativeWebView", {
    postMessage: (data: string) => posted.push(JSON.parse(data) as PostedMessage),
  });
  return posted;
}

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + index % 251) % 256;
  return bytes;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNativeReader", () => {
  it("is false in a plain browser environment", () => {
    expect(isNativeReader()).toBe(false);
  });

  it("detects the injected ReactNativeWebView object", () => {
    vi.stubGlobal("ReactNativeWebView", { postMessage: () => undefined });
    expect(isNativeReader()).toBe(true);
  });

  it("detects the reader bootstrap bridge flag", () => {
    vi.stubGlobal("__jojoNativeReaderBridge", {});
    expect(isNativeReader()).toBe(true);
  });

  it("detects the mobile app user agent", () => {
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Mozilla/5.0 JOJOKanbaoMobile/1.0" });
    expect(isNativeReader()).toBe(true);
  });
});

describe("postPdfDownloadToNative", () => {
  it("posts a start message with the filename and byte totals", async () => {
    const posted = capturePostMessages();
    const bytes = patternBytes(1024);
    await postPdfDownloadToNative(bytes, "rmrb-19660701.pdf");
    expect(posted[0]).toMatchObject({
      type: "pdf-download-start",
      filename: "rmrb-19660701.pdf",
      totalBytes: bytes.length,
      totalChunks: 1,
    });
    expect(posted[posted.length - 1]).toMatchObject({ type: "pdf-download-end", downloadId: posted[0]!.downloadId });
  });

  it("splits large PDFs into ordered chunks that reassemble byte for byte", async () => {
    const posted = capturePostMessages();
    const bytes = patternBytes(CHUNK_BYTES * 2 + 1234);
    await postPdfDownloadToNative(bytes, "rmrb-20240101.pdf");

    const chunks = posted.filter((message) => message.type === "pdf-download-chunk");
    expect(posted[0]).toMatchObject({ totalBytes: bytes.length, totalChunks: chunks.length, chunkSize: CHUNK_BYTES });
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));

    const downloadId = posted[0]!.downloadId;
    expect(chunks.every((chunk) => chunk.downloadId === downloadId)).toBe(true);
    const reassembled = new Uint8Array(bytes.length);
    let offset = 0;
    for (const chunk of chunks) {
      const decoded = decodeBase64(chunk.data!);
      reassembled.set(decoded, offset);
      offset += decoded.length;
    }
    expect(offset).toBe(bytes.length);
    expect(reassembled).toEqual(bytes);
  });

  it("encodes multi-megabyte arrays without overflowing the call stack", async () => {
    const posted = capturePostMessages();
    const bytes = patternBytes(CHUNK_BYTES * 3);
    await expect(postPdfDownloadToNative(bytes, "big.pdf")).resolves.toBeUndefined();
    const postedBytes = posted
      .filter((message) => message.type === "pdf-download-chunk")
      .reduce((total, chunk) => total + atob(chunk.data!).length, 0);
    expect(postedBytes).toBe(bytes.length);
  });

  it("rejects PDFs above the native transfer limit without posting anything", async () => {
    const posted = capturePostMessages();
    const bytes = new Uint8Array(NATIVE_PDF_DOWNLOAD_MAX_BYTES + 1);
    await expect(postPdfDownloadToNative(bytes, "huge.pdf")).rejects.toThrow("文件过大");
    expect(posted).toHaveLength(0);
  });

  it("throws when there is no native shell to receive the bytes", async () => {
    await expect(postPdfDownloadToNative(patternBytes(16), "a.pdf")).rejects.toThrow("客户端");
  });
});
