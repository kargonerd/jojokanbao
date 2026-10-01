import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), directories: new Set<string>() }));
const sharing = vi.hoisted(() => ({
  // Snapshot the bytes at share time: the assembler deletes the temp file as
  // soon as the share sheet is dismissed, which races an after-the-fact read.
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async (uri: string) => {
    shared.push([uri, disk.files.get(uri)]);
  }),
}));
const shared: Array<[string, Uint8Array | undefined]> = [];
const saf = vi.hoisted(() => ({
  requestDirectoryPermissionsAsync: vi.fn(),
  createFileAsync: vi.fn(async (_parentUri: string, _name: string, _mimeType: string) => "content://picked/new.pdf"),
  writeAsStringAsync: vi.fn(async (_uri: string, _data: string, _options?: { encoding?: "base64"; append?: boolean }) => undefined),
}));
// Mutable so each test picks the platform the branch under test needs.
const rn = vi.hoisted(() => ({ os: "android", version: 30, alert: vi.fn() }));
const store = vi.hoisted(() => {
  const state: { pdfSaveDirectoryUri: string | null; setCalls: Array<string | null> } = {
    pdfSaveDirectoryUri: null,
    setCalls: [],
  };
  return { state };
});

vi.mock("react-native", () => ({
  Platform: { get OS() { return rn.os; }, get Version() { return rn.version; } },
  Alert: { alert: rn.alert },
}));
vi.mock("../store/mobileStore", () => ({
  useMobileStore: {
    getState: () => ({
      pdfSaveDirectoryUri: store.state.pdfSaveDirectoryUri,
      setPdfSaveDirectoryUri: (uri: string | null) => {
        store.state.pdfSaveDirectoryUri = uri;
        store.state.setCalls.push(uri);
      },
    }),
  },
}));

vi.mock("expo-file-system", () => {
  const path = (parent: string | { uri: string }, name: string) => `${typeof parent === "string" ? parent : parent.uri}/${name}`;
  class File {
    uri: string;
    constructor(parent: string | { uri: string }, name: string) { this.uri = path(parent, name); }
    get exists() { return disk.files.has(this.uri); }
    write(value: Uint8Array | string) { disk.files.set(this.uri, typeof value === "string" ? new TextEncoder().encode(value) : value.slice()); }
    async bytes() { return disk.files.get(this.uri)!.slice(); }
    delete() { disk.files.delete(this.uri); }
  }
  class Directory {
    uri: string;
    constructor(parent: string | { uri: string }, name: string) { this.uri = path(parent, name); }
    get exists() { return disk.directories.has(this.uri); }
    create() { disk.directories.add(this.uri); }
  }
  return { File, Directory, Paths: { document: "document", cache: "cache" } };
});

vi.mock("expo-file-system/legacy", () => ({ StorageAccessFramework: saf }));

vi.mock("expo-sharing", () => sharing);

import { PdfDownloadAssembler, base64ToBytes, parsePdfDownloadMessage, type PdfDownloadMessage } from "./pdfDownloadReceive";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function start(overrides: Partial<Extract<PdfDownloadMessage, { type: "pdf-download-start" }>> = {}): Extract<PdfDownloadMessage, { type: "pdf-download-start" }> {
  return {
    type: "pdf-download-start",
    downloadId: "pdf-1",
    filename: "rmrb-19660701.pdf",
    totalBytes: 8,
    totalChunks: 2,
    ...overrides,
  };
}

function chunk(seq: number, bytes: Uint8Array, downloadId = "pdf-1"): Extract<PdfDownloadMessage, { type: "pdf-download-chunk" }> {
  return { type: "pdf-download-chunk", downloadId, seq, data: toBase64(bytes) };
}

function sharedFileUris(): string[] {
  return sharing.shareAsync.mock.calls.map((call) => call[0] as string);
}

function pressAlertButton(label: string): void {
  const buttons = rn.alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }> | undefined;
  const button = buttons?.find((candidate) => candidate.text === label);
  if (!button) throw new Error(`Alert button ${label} was not shown`);
  button.onPress?.();
}

beforeEach(() => {
  disk.files.clear();
  disk.directories.clear();
  shared.length = 0;
  rn.os = "android";
  rn.version = 30;
  rn.alert.mockReset();
  saf.requestDirectoryPermissionsAsync.mockReset();
  saf.createFileAsync.mockReset().mockImplementation(async () => "content://picked/new.pdf");
  saf.writeAsStringAsync.mockReset().mockImplementation(async () => undefined);
  sharing.isAvailableAsync.mockClear();
  sharing.shareAsync.mockClear();
  store.state.pdfSaveDirectoryUri = null;
  store.state.setCalls = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parsePdfDownloadMessage", () => {
  it("rejects malformed payloads and unrelated bridge messages", () => {
    expect(parsePdfDownloadMessage("not json")).toBeNull();
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "page", current: 1, total: 8 }))).toBeNull();
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-start", downloadId: "pdf-1" }))).toBeNull();
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-start", downloadId: "pdf-1", filename: "", totalBytes: 8, totalChunks: 1 }))).toBeNull();
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-start", downloadId: "pdf-1", filename: "a.pdf", totalBytes: 1.5, totalChunks: 1 }))).toBeNull();
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-chunk", downloadId: "pdf-1", seq: -1, data: "AAAA" }))).toBeNull();
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-chunk", downloadId: "pdf-1", seq: 0, data: "x".repeat(5 * 1024 * 1024) }))).toBeNull();
  });

  it("accepts the four canonical message shapes", () => {
    expect(parsePdfDownloadMessage(JSON.stringify(start()))).toEqual(start());
    expect(parsePdfDownloadMessage(JSON.stringify(chunk(0, new Uint8Array([1, 2]))))).toEqual(chunk(0, new Uint8Array([1, 2])));
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-end", downloadId: "pdf-1" }))).toEqual({ type: "pdf-download-end", downloadId: "pdf-1" });
    expect(parsePdfDownloadMessage(JSON.stringify({ type: "pdf-download-error", downloadId: "pdf-1", message: "boom" }))).toEqual({ type: "pdf-download-error", downloadId: "pdf-1", message: "boom" });
  });
});

describe("base64ToBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(base64ToBytes(toBase64(bytes))).toEqual(bytes);
  });
});

describe("PdfDownloadAssembler on Android 11+ (SAF)", () => {
  it("silently writes an authorized transfer into the picked directory", async () => {
    store.state.pdfSaveDirectoryUri = "content://picked-dir";
    const assembler = new PdfDownloadAssembler();
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([250, 0, 128, 9]);
    assembler.handle(start());
    assembler.handle(chunk(0, first));
    assembler.handle(chunk(1, second));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });

    await vi.waitFor(() => expect(rn.alert).toHaveBeenCalledWith("已保存 PDF", "文件已保存到你选择的文件夹。"));
    expect(saf.createFileAsync).toHaveBeenCalledWith("content://picked-dir", "rmrb-19660701", "application/pdf");
    expect(saf.writeAsStringAsync).toHaveBeenCalledTimes(2);
    expect(saf.writeAsStringAsync.mock.calls.map((call) => call[1])).toEqual([toBase64(first), toBase64(second)]);
    expect(saf.writeAsStringAsync.mock.calls.map((call) => (call[2] as { append: boolean }).append)).toEqual([false, true]);
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(disk.files.size).toBe(0);
  });

  it("asks for a directory once, persists the grant, and saves", async () => {
    saf.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: "content://just-granted" });
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start());
    assembler.handle(chunk(0, new Uint8Array([1, 2, 3, 4])));
    assembler.handle(chunk(1, new Uint8Array([250, 0, 128, 9])));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });

    await vi.waitFor(() => expect(rn.alert).toHaveBeenCalledWith("保存 PDF", expect.stringContaining("首次保存"), expect.anything()));
    pressAlertButton("选择位置");
    await vi.waitFor(() => expect(saf.createFileAsync).toHaveBeenCalledWith("content://just-granted", "rmrb-19660701", "application/pdf"));
    expect(store.state.pdfSaveDirectoryUri).toBe("content://just-granted");
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });

  it("falls back to the share sheet when the user cancels the grant", async () => {
    saf.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: false });
    const assembler = new PdfDownloadAssembler();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    assembler.handle(start());
    assembler.handle(chunk(0, bytes.slice(0, 4)));
    assembler.handle(chunk(1, bytes.slice(4)));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });

    await vi.waitFor(() => expect(rn.alert).toHaveBeenCalledWith("保存 PDF", expect.anything(), expect.anything()));
    pressAlertButton("取消");
    await vi.waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(saf.createFileAsync).not.toHaveBeenCalled();
    expect(shared[0]?.[1]).toEqual(bytes);
  });

  it("clears the persisted grant and falls back to sharing when the SAF write fails", async () => {
    store.state.pdfSaveDirectoryUri = "content://stale-dir";
    saf.createFileAsync.mockRejectedValue(new Error("SecurityException"));
    const assembler = new PdfDownloadAssembler();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    assembler.handle(start());
    assembler.handle(chunk(0, bytes.slice(0, 4)));
    assembler.handle(chunk(1, bytes.slice(4)));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });

    await vi.waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(store.state.pdfSaveDirectoryUri).toBeNull();
    expect(shared[0]?.[1]).toEqual(bytes);
  });

  it("still falls back to the share sheet below Android 11", async () => {
    rn.version = 29;
    const assembler = new PdfDownloadAssembler();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    assembler.handle(start());
    assembler.handle(chunk(0, bytes.slice(0, 4)));
    assembler.handle(chunk(1, bytes.slice(4)));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });

    await vi.waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(saf.createFileAsync).not.toHaveBeenCalled();
    expect(rn.alert).not.toHaveBeenCalled();
  });
});

describe("PdfDownloadAssembler share fallback (iOS and other platforms)", () => {
  beforeEach(() => {
    rn.os = "ios";
  });

  it("reassembles an ordered transfer, shares it, and removes the temp file", async () => {
    const assembler = new PdfDownloadAssembler();
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([250, 0, 128, 9]);
    assembler.handle(start());
    assembler.handle(chunk(0, first));
    assembler.handle(chunk(1, second));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    await vi.waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledTimes(1));

    const uri = sharedFileUris()[0];
    expect(uri).toBe("cache/pdf-share/rmrb-19660701.pdf");
    expect(sharing.shareAsync).toHaveBeenCalledWith(uri, expect.objectContaining({ mimeType: "application/pdf", UTI: "com.adobe.pdf" }));
    expect(shared[0]?.[1]).toEqual(new Uint8Array([...first, ...second]));
    await vi.waitFor(() => expect(disk.files.has(uri)).toBe(false));
  });

  it("aborts on out-of-order chunks instead of writing a corrupt PDF", async () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start());
    assembler.handle(chunk(1, new Uint8Array([1])));
    assembler.handle(chunk(0, new Uint8Array([2])));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    await Promise.resolve();
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(disk.files.size).toBe(0);
  });

  it("requires every byte to arrive before sharing", async () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start({ totalChunks: 3 }));
    assembler.handle(chunk(0, new Uint8Array([1])));
    assembler.handle(chunk(1, new Uint8Array([2])));
    // Chunk 2 never arrives.
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    await Promise.resolve();
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });

  it("ignores chunks from a different download session", () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start());
    assembler.handle(chunk(0, new Uint8Array([1]), "pdf-other"));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-other" });
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });

  it("a pdf-download-error message drops the pending session", () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start());
    assembler.handle(chunk(0, new Uint8Array([1])));
    assembler.handle({ type: "pdf-download-error", downloadId: "pdf-1", message: "cancelled" });
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });

  it("sanitizes unsafe filenames before writing", async () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start({ filename: "../evil path?.pdf", totalBytes: 8, totalChunks: 1 }));
    assembler.handle(chunk(0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    await vi.waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(sharedFileUris()[0]).toBe("cache/pdf-share/_evil_path_.pdf");
  });

  it("drops a stalled session after the inactivity timeout", () => {
    vi.useFakeTimers();
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start());
    assembler.handle(chunk(0, new Uint8Array([1])));
    vi.advanceTimersByTime(60_000);
    assembler.handle(chunk(1, new Uint8Array([1])));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });

  it("a new start replaces a stalled previous session", async () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start({ downloadId: "pdf-stale", totalChunks: 2 }));
    assembler.handle(start({ downloadId: "pdf-new", totalBytes: 2, totalChunks: 2 }));
    assembler.handle(chunk(0, new Uint8Array([1]), "pdf-new"));
    assembler.handle(chunk(1, new Uint8Array([1]), "pdf-new"));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-new" });
    await vi.waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledTimes(1));
  });

  it("dispose clears any pending transfer", () => {
    const assembler = new PdfDownloadAssembler();
    assembler.handle(start());
    assembler.handle(chunk(0, new Uint8Array([1])));
    assembler.dispose();
    assembler.handle(chunk(1, new Uint8Array([1])));
    assembler.handle({ type: "pdf-download-end", downloadId: "pdf-1" });
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });
});
