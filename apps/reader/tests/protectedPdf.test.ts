import { describe, expect, it, vi } from "vitest";

function installPdfJsImportPolyfills() {
  if (!("DOMMatrix" in globalThis)) {
    (globalThis as typeof globalThis & { DOMMatrix: typeof DOMMatrix }).DOMMatrix = class DOMMatrix {} as typeof DOMMatrix;
  }
  if (!("try" in Promise)) {
    (Promise as typeof Promise & { try: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown> }).try = (
      fn,
      ...args
    ) => Promise.resolve(fn(...args));
  }
  if (!("toHex" in Uint8Array.prototype)) {
    Object.defineProperty(Uint8Array.prototype, "toHex", {
      value() {
        return Array.from(this as Uint8Array, (byte) => byte.toString(16).padStart(2, "0")).join("");
      },
    });
  }
}

async function loadProtectionModule() {
  installPdfJsImportPolyfills();
  return import("@jojo/pdf-viewer");
}

function makePdf(text: string, paddingLength = 0): Uint8Array {
  const encoder = new TextEncoder();
  const padding = paddingLength > 0 ? `% ${"x".repeat(paddingLength)}\n` : "";
  const stream = `BT /F1 24 Tf 40 120 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let body = `%PDF-1.4\n${padding}`;
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(body).length);
    body += object;
  }

  const xrefOffset = encoder.encode(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(body);
}

function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function byteArray(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

async function readPdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  await doc.destroy();
  return content.items.map((item) => ("str" in item ? item.str : "")).join("");
}

async function expectPdfOpenFailure(bytes: Uint8Array): Promise<void> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true });
  await expect(task.promise).rejects.toThrow();
}

function createRangeFetch(bytes: Uint8Array) {
  const ranges: string[] = [];
  const readRangeHeader = (source: RequestInfo | URL | HeadersInit | undefined): string | null => {
    if (!source || typeof source === "string" || source instanceof URL) return null;
    if (source instanceof Request) return source.headers.get("Range");
    if (source instanceof Headers) return source.get("Range");
    if (Array.isArray(source)) {
      return source.find(([name]) => name.toLowerCase() === "range")?.[1] ?? null;
    }
    for (const [name, value] of Object.entries(source)) {
      if (name.toLowerCase() === "range" && typeof value === "string") return value;
    }
    return null;
  };

  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": String(bytes.length) },
      });
    }

    const range = readRangeHeader(init?.headers) ?? readRangeHeader(url);
    if (!range) {
      ranges.push("full");
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "Content-Length": String(bytes.length) },
      });
    }
    ranges.push(range);

    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`Invalid Range header: ${range}`);

    const begin = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    const chunk = bytes.slice(begin, end + 1);

    return new Response(chunk.buffer as ArrayBuffer, {
      status: 206,
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${begin}-${end}/${bytes.length}`,
      },
    });
  });

  return { fetchFn, ranges };
}

async function waitForMicrotasks() {
  await Promise.resolve();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const samples = [
  { name: "short text page", text: "CrawlerText", padding: 0 },
  { name: "metadata sized page", text: "JOJOArchive", padding: 96 },
  { name: "large newspaper-like page", text: "RangeDaily", padding: 4096 },
];

describe("protected reader PDFs", () => {
  it("rejects a server that ignores Range without reading the full response body", async () => {
    const { resolvePdfSource } = await loadProtectionModule();
    const cancel = vi.fn(async () => {});
    const arrayBuffer = vi.fn(async () => makePdf("Must Not Download").buffer);
    const fetchFn = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ "Content-Length": "999999" }),
      body: { cancel },
      arrayBuffer,
    })) as unknown as typeof fetch;

    await expect(resolvePdfSource("https://cdn.example.test/full.pdf", "auto", { fetchFn }))
      .rejects.toThrow("refusing to download the complete file");
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each(samples)("protects and restores $name", async ({ text, padding }) => {
    const { hasPdfMagic, protectPdfBytes, unprotectPdfBytes } = await loadProtectionModule();
    const original = makePdf(text, padding);
    const protectedPdf = protectPdfBytes(original);

    expect(hasPdfMagic(original)).toBe(true);
    expect(hasPdfMagic(protectedPdf)).toBe(false);
    expect(latin1(protectedPdf)).not.toContain(text);
    await expectPdfOpenFailure(protectedPdf);

    const restored = unprotectPdfBytes(protectedPdf);
    expect(byteArray(restored)).toEqual(byteArray(original));
    await expect(readPdfText(restored)).resolves.toContain(text);

    for (const [begin, end] of [
      [0, 17],
      [11, 83],
      [Math.max(0, original.length - 128), original.length],
    ]) {
      const restoredRange = unprotectPdfBytes(protectedPdf.slice(begin, end), begin);
      expect(byteArray(restoredRange)).toEqual(byteArray(original.slice(begin, end)));
    }
  });

  it("uses CDN byte ranges and returns decoded chunks to pdf.js transport", async () => {
    const { protectPdfBytes, resolvePdfSource } = await loadProtectionModule();
    const original = makePdf("Transport Range Text", 2048);
    const protectedPdf = protectPdfBytes(original);
    const { fetchFn, ranges } = createRangeFetch(protectedPdf);

    const source = await resolvePdfSource("https://cdn.example.test/RMRB/1946/19460515.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize: 64,
    });

    expect(source.kind).toBe("protected");
    if (source.kind !== "protected") return;
    expect(byteArray(source.initialData)).toEqual(byteArray(original.slice(0, 64)));
    expect(ranges[0]).toBe("bytes=0-63");

    const events: Array<{ type: string; begin: number; chunk: Uint8Array }> = [];
    source.transport.transportReady((event: { type: string; begin: number; chunk: Uint8Array }) => {
      events.push(event);
    });
    source.transport.requestDataRange(97, 181);
    await waitForMicrotasks();

    expect(ranges).toContain("bytes=97-180");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("range");
    expect(events[0]?.begin).toBe(97);
    expect(byteArray(events[0]?.chunk ?? new Uint8Array())).toEqual(byteArray(original.slice(97, 181)));
  });

  it("opens a protected range source through pdf.js", async () => {
    const { protectPdfBytes, resolvePdfSource } = await loadProtectionModule();
    const original = makePdf("PdfJsRange", 2048);
    const protectedPdf = protectPdfBytes(original);
    const { fetchFn, ranges } = createRangeFetch(protectedPdf);

    const source = await resolvePdfSource("https://cdn.example.test/RMRB/1946/19460515.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize: 64,
    });

    expect(source.kind).toBe("protected");
    if (source.kind !== "protected") return;

    const { getDocument } = await import("pdfjs-dist");
    const task = getDocument({
      range: source.transport,
      disableAutoFetch: true,
      disableFontFace: true,
      disableStream: true,
    });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    await doc.destroy();

    expect(content.items.map((item) => ("str" in item ? item.str : "")).join("")).toContain("PdfJsRange");
    expect(ranges.some((range) => range !== "bytes=0-63")).toBe(true);
  });

  it("opens a large plain PDF without transferring every byte", async () => {
    const { resolvePdfSource } = await loadProtectionModule();
    const original = makePdf("DemandRange", 1024 * 1024);
    const { fetchFn, ranges } = createRangeFetch(original);
    const rangeChunkSize = 64 * 1024;

    const source = await resolvePdfSource("https://cdn.example.test/large.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize,
    });

    expect(source.kind).toBe("plain");
    const { getDocument } = await import("pdfjs-dist");
    const task = getDocument({
      range: source.transport,
      rangeChunkSize,
      disableAutoFetch: true,
      disableFontFace: true,
      disableStream: true,
    });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    await doc.destroy();

    const transferredBytes = [...new Set(ranges)].reduce((total, range) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      return match ? total + Number(match[2]) - Number(match[1]) + 1 : total;
    }, 0);
    expect(content.items.map((item) => ("str" in item ? item.str : "")).join(""))
      .toContain("DemandRange");
    expect(ranges).not.toContain("full");
    expect(transferredBytes).toBeLessThan(original.length);
  });

  it.each(samples)("downloads a restored PDF for $name", async ({ text, padding }) => {
    const { fetchPdfDownloadBytes, protectPdfBytes } = await loadProtectionModule();
    const original = makePdf(text, padding);
    const protectedPdf = protectPdfBytes(original);
    const { fetchFn, ranges } = createRangeFetch(protectedPdf);

    await expectPdfOpenFailure(protectedPdf);

    const download = await fetchPdfDownloadBytes("https://cdn.example.test/download.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize: 128,
    });

    expect(download.protected).toBe(true);
    expect(byteArray(download.bytes)).toEqual(byteArray(original));
    await expect(readPdfText(download.bytes)).resolves.toContain(text);
    expect(ranges[0]).toBe("bytes=0-127");
    expect(ranges.every((range) => range.startsWith("bytes="))).toBe(true);
  });

  it("keeps plain PDFs readable during migration when auto mode is used", async () => {
    const { resolvePdfSource } = await loadProtectionModule();
    const original = makePdf("Plain Migration Text");
    const { fetchFn, ranges } = createRangeFetch(original);

    const source = await resolvePdfSource("https://cdn.example.test/plain.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize: 64,
    });

    expect(source.kind).toBe("plain");
    expect(source.transport).toBeDefined();
    expect(ranges).toEqual(["bytes=0-63"]);
  });

  it("uses HEAD length when a valid partial response has an unknown total", async () => {
    const { resolvePdfSource } = await loadProtectionModule();
    const original = makePdf("Unknown Range Total");
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Length": String(original.length) },
        });
      }

      const end = Math.min(63, original.length - 1);
      return new Response(original.slice(0, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes 0-${end}/*` },
      });
    });

    const source = await resolvePdfSource("https://cdn.example.test/unknown-total.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize: 64,
    });

    expect(source.kind).toBe("plain");
    expect(source.length).toBe(original.length);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("downloads plain PDFs unchanged during migration when auto mode is used", async () => {
    const { fetchPdfDownloadBytes } = await loadProtectionModule();
    const original = makePdf("PlainDownload");
    const { fetchFn, ranges } = createRangeFetch(original);

    const download = await fetchPdfDownloadBytes("https://cdn.example.test/plain.pdf", "auto", {
      fetchFn: fetchFn as unknown as typeof fetch,
      rangeChunkSize: 64,
    });

    expect(download.protected).toBe(false);
    expect(byteArray(download.bytes)).toEqual(byteArray(original));
    await expect(readPdfText(download.bytes)).resolves.toContain("PlainDownload");
    expect(ranges[0]).toBe("bytes=0-63");
    expect(ranges.every((range) => range.startsWith("bytes="))).toBe(true);
  });
});
