import { test, expect, type Page } from "@playwright/test";

import { gzipSync } from "node:zlib";
import { transformJoxBytes } from "@jojo/content";

function pdfUrl(publication: string, issue: string): string {
  const day = issue.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const path = issue.length === 8 ? `${issue.slice(0, 4)}/${issue.slice(4, 6)}/${day}` : `${issue.slice(0, 4)}/${issue}`;
  return `https://blacknews.jojokanbao.cn/content/newspapers/${publication}/items/${path}/assets/issue.pdf.jox?v=fixture`;
}

const pdfPattern = "https://blacknews.jojokanbao.cn/**/*.pdf.jox*";
function encodePdfRange(url: string, bytes: Buffer, offset = 0): Buffer {
  return Buffer.from(transformJoxBytes(bytes, new URL(url).pathname.slice(1), offset));
}

test.beforeEach(async ({ page }) => {
  // Metadata fixtures use the same Jox encoding and manifest indirection as production.
  await page.route(/https:\/\/blacknews\.jojokanbao\.cn\/(catalog|content\/newspapers\/.*\/(index|manifest))\.jox$/, async (route) => {
    const key = new URL(route.request().url()).pathname.slice(1);
    const publication = key.split("/")[2] ?? "rmrb";
    let value: unknown;
    if (key === "catalog.jox") {
      value = { formatVersion: "jojo-catalog/1", datasets: ["rmrb", "ckxx", "hq", "rmhb", "sjzs"].map(datasetId => ({ datasetId, indexObject: `content/newspapers/${datasetId}/index.jox` })) };
    } else if (key.endsWith("/index.jox")) {
      value = { formatVersion: "jojo-delivery-index/1", datasetId: publication,
        itemPath: "items/{YYYY}/{MM}/{YYYY-MM-DD}/manifest.jox",
        items: ["196419", "196491", "197292", "196513"].map(itemKey => ({ itemKey, manifestObject: `items/${itemKey.slice(0, 4)}/${itemKey}/manifest.jox` })),
      };
    } else {
      const issue = key.split("/").at(-2);
      value = { formatVersion: "jojo-item-manifest/1", datasetId: publication, itemId: `${publication}:${issue}`,
        assets: [{ type: "pdf", role: "issue-pdf", mediaType: "application/pdf", object: "assets/issue.pdf.jox", sha256: "fixture" }],
      };
    }
    await route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(transformJoxBytes(gzipSync(JSON.stringify(value)), key)), headers: { "Access-Control-Allow-Origin": "*" } });
  });
});

const PAGE_COUNT = 6;
const RANGE_CHUNK_SIZE = 256 * 1024;

function padOffset(value: number): string {
  return String(value).padStart(10, "0");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "ascii");
}

// Build a multi-page linearized PDF whose later page objects are deliberately
// spread across the file. The first page is complete in the initial range, so
// waiting for every middle chunk before showing its canvas is a regression.
function makeDemandLoadedPdf(pagePaddingLength = 300_000): Buffer {
  const maxObjectNumber = 4 + PAGE_COUNT * 2;
  const header = "%PDF-1.7\n%JOJO\n";
  const makeLinearization = (length = 0, hintOffset = 0, hintLength = 1, endFirst = 1, mainXref = 1) =>
    `1 0 obj\n<< /Linearized 1 /L ${padOffset(length)} /H [ ${padOffset(hintOffset)} ${padOffset(hintLength)} ] /O 5 /E ${padOffset(endFirst)} /N ${PAGE_COUNT} /T ${padOffset(mainXref + 8)} >>\nendobj\n`;
  const makeFirstXref = (offsets = new Map<number, number>(), previous = 0) => {
    let xref = `xref\n1 1\n${padOffset(offsets.get(1) ?? 0)} 00000 n \n3 ${maxObjectNumber - 2}\n`;
    for (let objectNumber = 3; objectNumber <= maxObjectNumber; objectNumber += 1) {
      xref += `${padOffset(offsets.get(objectNumber) ?? 0)} 00000 n \n`;
    }
    return `${xref}trailer << /Root 3 0 R /Size ${maxObjectNumber + 1} /Prev ${padOffset(previous)} >>\nstartxref\n0000000000\n%%EOF\n`;
  };

  const placeholderPrefix = header + makeLinearization() + makeFirstXref();
  const offsets = new Map<number, number>([[1, byteLength(header)]]);
  let cursor = byteLength(placeholderPrefix);
  let body = "";
  const addObject = (objectNumber: number, value: string) => {
    offsets.set(objectNumber, cursor);
    body += value;
    cursor += byteLength(value);
  };

  addObject(3, "3 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const hintStream = "0".repeat(64);
  addObject(4, `4 0 obj\n<< /S 36 /Length 64 >>\nstream\n${hintStream}\nendstream\nendobj\n`);
  const hintLength = cursor - offsets.get(4)!;
  let endFirstPage = 0;

  for (let index = 0; index < PAGE_COUNT; index += 1) {
    const pageObject = 5 + index * 2;
    const contentObject = pageObject + 1;
    addObject(
      pageObject,
      `${pageObject} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentObject} 0 R >>\nendobj\n`,
    );
    const stream = `BT\n/F1 12 Tf\n20 220 Td\n(Page ${index + 1} selectable text) Tj\nET\nBT\n/F1 12 Tf\n0 1 -1 0 160 80 Tm\n(Rotated text) Tj\nET\n`;
    addObject(
      contentObject,
      `${contentObject} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
    );
    if (index === 0) endFirstPage = cursor;
    if (index < PAGE_COUNT - 1) {
      const padding = `% ${"x".repeat(pagePaddingLength)}\n`;
      body += padding;
      cursor += byteLength(padding);
    }
  }

  const kids = Array.from({ length: PAGE_COUNT }, (_, index) => `${5 + index * 2} 0 R`).join(" ");
  addObject(2, `2 0 obj\n<< /Type /Pages /Count ${PAGE_COUNT} /Kids [ ${kids} ] >>\nendobj\n`);

  const mainXrefOffset = cursor;
  const firstXrefOffset = byteLength(header + makeLinearization());
  const mainXref =
    `xref\n0 1\n0000000000 65535 f \n2 1\n${padOffset(offsets.get(2)!)} 00000 n \n` +
    `trailer << /Size ${maxObjectNumber + 1} >>\nstartxref\n${padOffset(firstXrefOffset)}\n%%EOF\n`;
  const totalLength = cursor + byteLength(mainXref);
  const linearization = makeLinearization(
    totalLength,
    offsets.get(4)!,
    hintLength,
    endFirstPage,
    mainXrefOffset,
  );
  const firstXref = makeFirstXref(offsets, mainXrefOffset);

  if (byteLength(header + linearization + firstXref) !== byteLength(placeholderPrefix)) {
    throw new Error("Linearized PDF prefix changed length");
  }
  return Buffer.from(header + linearization + firstXref + body + mainXref, "ascii");
}

async function servePdfRanges(page: Page, pdf: Buffer): Promise<void> {
  await page.route(pdfPattern, async (route) => {
    const range = route.request().headers().range;
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match) {
      await route.fulfill({ status: 500, body: "Range header required" });
      return;
    }
    const begin = Number(match[1]);
    const end = Math.min(Number(match[2]), pdf.length - 1);
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Content-Length": String(end - begin + 1),
        "Content-Range": `bytes ${begin}-${end}/${pdf.length}`,
        "Content-Type": "application/pdf",
      },
      body: encodePdfRange(route.request().url(), pdf.subarray(begin, end + 1), begin),
    });
  });
}

test("reader shows the first page before all PDF ranges return", async ({ page }) => {
  test.setTimeout(60_000);
  const pdf = makeDemandLoadedPdf();
  const requests: Array<{ begin: number; end: number }> = [];
  let fullRequestSeen = false;

  await page.route(pdfUrl("rmrb", "19761009"), async (route) => {
    const range = route.request().headers().range;
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match) {
      fullRequestSeen = true;
      await route.fulfill({ status: 500, body: "Range header required" });
      return;
    }

    const begin = Number(match[1]);
    const end = Math.min(Number(match[2]), pdf.length - 1);
    requests.push({ begin, end });
    // An eager last-page check groups the middle of this fixture into one
    // oversized request and would block the first canvas here. Demand mode
    // asks only for the single chunk needed by page one.
    if (begin === RANGE_CHUNK_SIZE && end >= RANGE_CHUNK_SIZE * 3) {
      await new Promise((resolve) => setTimeout(resolve, 25_000));
    }
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Content-Length": String(end - begin + 1),
        "Content-Range": `bytes ${begin}-${end}/${pdf.length}`,
        "Content-Type": "application/pdf",
      },
      body: encodePdfRange(route.request().url(), pdf.subarray(begin, end + 1), begin),
    });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  const canvas = page.locator("#page-1 canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
  await expect(page.locator("#page-6")).toHaveCount(1);

  const transferredBytes = requests.reduce((total, request) => total + request.end - request.begin + 1, 0);
  expect(fullRequestSeen).toBe(false);
  expect(requests[0]).toEqual({ begin: 0, end: RANGE_CHUNK_SIZE - 1 });
  expect(transferredBytes, JSON.stringify(requests)).toBeLessThan(pdf.length);
});

test("reader falls back to a full PDF when the browser rejects Range transport", async ({ page }) => {
  const pdf = makeDemandLoadedPdf(1_000);
  let rangeRequests = 0;
  let fullRequests = 0;

  await page.route(pdfUrl("rmrb", "19761009"), async (route) => {
    if (route.request().headers().range) {
      rangeRequests += 1;
      await route.abort("failed");
      return;
    }

    fullRequests += 1;
    await route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Length": String(pdf.length),
        "Content-Type": "application/pdf",
      },
      body: encodePdfRange(route.request().url(), pdf),
    });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  const canvas = page.locator("#page-1 canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
  // React StrictMode may start and cancel an extra initial request in dev.
  expect(rangeRequests).toBeGreaterThanOrEqual(1);
  expect(fullRequests).toBe(1);
  await expect(page.getByText("没有当天文档或数据缺失")).toHaveCount(0);
});

test("switching from a newspaper to a magazine never requests a stale mixed document id", async ({ page }) => {
  const pdfRequests: string[] = [];
  await page.route(pdfPattern, async (route) => {
    pdfRequests.push(route.request().url());
    await route.fulfill({ status: 404, body: "Not needed for route URL regression" });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  await expect.poll(() => pdfRequests.some((url) => url === pdfUrl("rmrb", "19761009"))).toBe(true);

  await page.evaluate(() => {
    window.history.pushState({}, "", "/archive/hq/196419");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/hq\/196419$/);
  await expect.poll(() => pdfRequests.some((url) => url.includes("/newspapers/hq/"))).toBe(true);

  expect(pdfRequests.filter((url) => url.includes("/newspapers/hq/"))).toEqual([
    pdfUrl("hq", "196419"),
  ]);
  expect(pdfRequests.some((url) => url.endsWith("/HQ/1976/1976100901.pdf"))).toBe(false);
});

test("reader explains a server that ignores Range without hiding navigation controls", async ({ page }) => {
  await page.route(pdfPattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      body: makeDemandLoadedPdf(1_000),
    });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("没有当天文档或数据缺失")).toBeVisible();
  await expect(page.getByText("PDF server ignored the Range header; refusing to download the complete file")).toBeVisible();
  await expect(page.getByRole("button", { name: "1976年10月09日" })).toBeVisible();
  await expect(page.locator("[data-pdf-page] canvas")).toHaveCount(0);
});

test("date and issue controls produce exact publication URLs", async ({ page }) => {
  const requests: string[] = [];
  await page.route(pdfPattern, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 404, body: "UI navigation only" });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "1976年10月09日" }).click();
  await page.getByRole("button", { name: "8", exact: true }).click();
  await expect(page).toHaveURL(/\/rmrb\/19761008$/);
  await expect.poll(() => requests.some((url) => url === pdfUrl("rmrb", "19761008"))).toBe(true);

  await page.goto("/hq/196419", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "第19期" }).click();
  await page.getByRole("option", { name: "增刊1" }).click();
  await expect(page).toHaveURL(/\/hq\/196491$/);
  await expect.poll(() => requests.some((url) => url === pdfUrl("hq", "196491"))).toBe(true);
  expect(requests.some((url) => url.includes("/HQ/1976/1976100901.pdf"))).toBe(false);
});

test("right-clicking a PDF page exposes the canvas and preserves selected-text actions", async ({ page }) => {
  await servePdfRanges(page, makeDemandLoadedPdf(1_000));
  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  const text = page.locator("#page-1 [data-pdf-text-layer] span").first();
  await expect(text).toHaveText("Page 1 selectable text");
  await page.evaluate(() => {
    document.addEventListener("contextmenu", (event) => {
      const target = event.target as HTMLElement;
      document.body.dataset.contextTarget = target.tagName;
      document.body.dataset.contextPage = target.closest("[data-page]")?.getAttribute("data-page") ?? "";
      document.body.dataset.contextPrevented = String(event.defaultPrevented);
      document.body.dataset.contextX = String(event.clientX);
      document.body.dataset.contextY = String(event.clientY);
      // The application must leave the event native. Only the test suppresses
      // the OS menu: WebKit's headless menu otherwise consumes later mouse input.
      event.preventDefault();
    });
  });

  await text.click({ button: "right" });
  await expect(page.locator("body")).toHaveAttribute("data-context-target", "CANVAS");
  await expect(page.locator("body")).toHaveAttribute("data-context-page", "1");
  await expect(page.locator("body")).toHaveAttribute("data-context-prevented", "false");
  // Native copy/save actions hit-test again later, when a menu item is chosen.
  // Checking contextmenu.target alone misses an overlay restored too early.
  const imageAtCommandTime = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const x = Number(document.body.dataset.contextX);
    const y = Number(document.body.dataset.contextY);
    const target = document.elementFromPoint(x, y);
    const canvas = target instanceof HTMLCanvasElement ? target : null;
    return { tag: target?.tagName, image: canvas?.toDataURL("image/png"), width: canvas?.width, height: canvas?.height };
  });
  expect(imageAtCommandTime.tag).toBe("CANVAS");
  const png = Buffer.from(imageAtCommandTime.image!.split(",")[1]!, "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(imageAtCommandTime.width);
  expect(png.readUInt32BE(20)).toBe(imageAtCommandTime.height);
  // After dismissing the menu, dragging at the same pointer position works
  // without first moving the mouse to restore the overlay.
  await page.keyboard.press("Escape");
  const samePositionBounds = (await text.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(samePositionBounds.x + samePositionBounds.width - 1, samePositionBounds.y + samePositionBounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).not.toBe("");
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await text.click({ button: "right" });
  await page.keyboard.press("Escape");
  const overlay = page.locator("#page-1 [data-pdf-text-layer-scale]");
  await expect(overlay).toHaveCSS("pointer-events", "auto");

  // A normal left-button drag still selects text after the native image menu.
  const bounds = await text.boundingBox();
  if (!bounds) throw new Error("PDF text is not visible");
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain("Page 1 selectable text");

  await text.click({ button: "right" });
  await expect(page.locator("body")).toHaveAttribute("data-context-target", "SPAN");
  await expect(page.locator("body")).toHaveAttribute("data-context-prevented", "false");
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain("Page 1 selectable text");

  // Clearing selection brings back the image menu, including at enlarged zoom.
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await page.getByRole("button", { name: "开启区域缩放" }).click();
  await expect(page.locator("[data-pdf-viewer]")).toHaveAttribute("data-zoom", "1.5");
  await text.click({ button: "right" });
  await expect(page.locator("body")).toHaveAttribute("data-context-target", "CANVAS");
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCSS("pointer-events", "auto");
});

test("browser download restores a readable PDF with the issue filename", async ({ page }) => {
  const pdf = makeDemandLoadedPdf(1_000);
  await servePdfRanges(page, pdf);
  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#page-1 canvas")).toBeVisible({ timeout: 20_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("rmrb-19761009.pdf");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).subarray(0, 5).toString("ascii")).toBe("%PDF-");
});

test("reader controls close consistently and keep the app navigation", async ({ page }) => {
  const pdf = makeDemandLoadedPdf(1_000);
  await page.route(pdfPattern, async (route) => {
    const range = route.request().headers().range;
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match) {
      await route.fulfill({ status: 500, body: "Range header required" });
      return;
    }
    const begin = Number(match[1]);
    const end = Math.min(Number(match[2]), pdf.length - 1);
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Content-Length": String(end - begin + 1),
        "Content-Range": `bytes ${begin}-${end}/${pdf.length}`,
        "Content-Type": "application/pdf",
      },
      body: encodePdfRange(route.request().url(), pdf.subarray(begin, end + 1), begin),
    });
  });
  await page.goto("/hq/196419", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-reader-page-status]")).toHaveText(`1 / ${PAGE_COUNT}`);

  const issueButton = page.getByRole("button", { name: "第19期" });
  await issueButton.click();
  const listbox = page.getByRole("listbox", { name: "期数" });
  await expect(listbox).toBeVisible();
  await expect(page.getByRole("option", { name: "第19期" })).toHaveAttribute("aria-selected", "true");
  expect(await listbox.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");

  const readerScrollContainer = page.locator("[data-reader-scroll-container]");
  await readerScrollContainer.evaluate((element) => { element.scrollTop = 400; });
  const readerScrollTop = await readerScrollContainer.evaluate((element) => element.scrollTop);
  await listbox.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const dropdownBounds = await listbox.locator("..").boundingBox();
  if (!dropdownBounds) throw new Error("Issue dropdown has no visible bounds");
  // The panel border is part of the issue control but not the scrollable list.
  // Wheel input there must not fall through to the PDF reader.
  await page.mouse.move(dropdownBounds.x + 1, dropdownBounds.y + 1);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => readerScrollContainer.evaluate((element) => element.scrollTop)).toBe(readerScrollTop);

  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);

  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByText("页面跳转")).toBeVisible();
  await page.mouse.click(8, 180);
  await expect(page.getByText("页面跳转")).toHaveCount(0);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("link", { name: "首页", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "资料库", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "杂志" })).toHaveCount(0);
});

test("mobile PDF slots omit text layers, keep their page ratio, and evict distant canvases", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
  });
  const pdf = makeDemandLoadedPdf(1_000);
  await page.route(pdfPattern, async (route) => {
    const range = route.request().headers().range;
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match) {
      await route.fulfill({ status: 500, body: "Range header required" });
      return;
    }
    const begin = Number(match[1]);
    const end = Math.min(Number(match[2]), pdf.length - 1);
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Content-Length": String(end - begin + 1),
        "Content-Range": `bytes ${begin}-${end}/${pdf.length}`,
        "Content-Type": "application/pdf",
      },
      body: encodePdfRange(route.request().url(), pdf.subarray(begin, end + 1), begin),
    });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  const firstCanvas = page.locator("#page-1 canvas");
  await expect(firstCanvas).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#page-2 canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-pdf-text-layer]")).toHaveCount(0);
  await expect(page.locator("[data-reader-page-status]")).toHaveText(`1 / ${PAGE_COUNT}`);
  await expect(page.getByRole("button", { name: "1976年10月09日" })).toHaveCSS("white-space", "nowrap");
  await expect(page.getByRole("button", { name: "复制阅读链接" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.locator("[data-pdf-page] canvas").count()).toBeLessThanOrEqual(3);
  await expect(page.locator("#page-4")).toHaveAttribute("data-page-state", "placeholder");

  const geometry = await page.locator("#page-1").evaluate((section) => {
    const canvas = section.querySelector("canvas")!;
    const sectionRect = section.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      heightDifference: Math.abs(sectionRect.height - canvasRect.height),
      pixelDensity: canvas.width / canvasRect.width,
      pixels: canvas.width * canvas.height,
    };
  });
  expect(geometry.heightDifference).toBeLessThan(2);
  expect(geometry.pixelDensity).toBeGreaterThanOrEqual(2.8);
  expect(geometry.pixels).toBeLessThanOrEqual(32_000_000);

  await page.locator("#page-6").scrollIntoViewIfNeeded();
  await expect(page.locator("#page-6 canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-reader-page-status]")).toHaveText(`6 / ${PAGE_COUNT}`);
  await expect(page).toHaveURL(/#page-6$/);
  await expect(page.locator("#page-1")).toHaveAttribute("data-page-state", "placeholder");
  await expect(page.locator("#page-1 canvas")).toHaveCount(0);
  expect(await page.locator("[data-pdf-page] canvas").count()).toBeLessThanOrEqual(3);

  await page.getByRole("button", { name: "设置" }).click();
  const qualitySlider = page.getByRole("slider", { name: "清晰度" });
  await expect(qualitySlider).toHaveValue("3");
  await expect(qualitySlider).toHaveAttribute("max", "3");
  const highQualityWidth = await page.locator("#page-6 canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width);
  await qualitySlider.fill("1");
  await expect(page.getByText("清晰度 (1)")).toBeVisible();
  await expect.poll(() => page.locator("#page-6 canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeLessThan(highQualityWidth);
  const lowQualityWidth = await page.locator("#page-6 canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width);
  await qualitySlider.fill("3");
  await expect.poll(() => page.locator("#page-6 canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(lowQualityWidth);
  const highQualityPixels = await page.locator("#page-6 canvas").evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    return element.width * element.height;
  });
  expect(highQualityPixels).toBeLessThanOrEqual(32_000_000);

  const zoomSlider = page.getByRole("slider", { name: "页面缩放" });
  await zoomSlider.fill("3");
  const highQualityWidthBeforeZoom = await page.locator("#page-6 canvas").evaluate((canvas) => (
    canvas as HTMLCanvasElement
  ).width);
  await page.getByRole("button", { name: "开启区域缩放" }).click();
  await expect(page.locator("[data-pdf-viewer]")).toHaveAttribute("data-zoom", "3");
  await expect(page.locator("[data-pdf-viewer]")).toHaveAttribute("data-touch-input", "true");
  expect(await page.locator("[data-pdf-zoom-content]").evaluate((element) => (
    getComputedStyle(element).userSelect
  ))).not.toBe("none");
  await expect(page.locator("[data-pdf-text-layer]")).toHaveCount(0);
  await expect(page.locator("[data-pdf-viewer]")).toHaveAttribute("data-render-zoom", "3");
  const upgradedCanvas = page.locator("[data-pdf-page][data-page-state='loaded'] canvas[data-pdf-render-zoom='3']").first();
  await expect(upgradedCanvas).toBeVisible();
  await expect(page.locator("canvas[data-pdf-render-zoom='3']")).toHaveCount(1);
  await expect.poll(() => upgradedCanvas.evaluate((canvas) => (
    canvas as HTMLCanvasElement
  ).width)).toBeGreaterThan(highQualityWidthBeforeZoom);
  const maximumZoomDensity = await upgradedCanvas.evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    return {
      canvasWidth: element.width,
      pixelDensity: element.width / element.getBoundingClientRect().width,
    };
  });
  expect(maximumZoomDensity.canvasWidth).toBeGreaterThan(highQualityWidthBeforeZoom);
  expect(maximumZoomDensity.pixelDensity).toBeGreaterThanOrEqual(2.8);
});

test("PDF region zooms in place, pans, and exits without a floating lens", async ({ page, browserName }) => {
  const pdf = makeDemandLoadedPdf(1_000);
  await page.route(pdfPattern, async (route) => {
    const range = route.request().headers().range;
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match) {
      await route.fulfill({ status: 500, body: "Range header required" });
      return;
    }
    const begin = Number(match[1]);
    const end = Math.min(Number(match[2]), pdf.length - 1);
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Content-Length": String(end - begin + 1),
        "Content-Range": `bytes ${begin}-${end}/${pdf.length}`,
        "Content-Type": "application/pdf",
      },
      body: encodePdfRange(route.request().url(), pdf.subarray(begin, end + 1), begin),
    });
  });

  await page.goto("/rmrb/19761009", { waitUntil: "domcontentloaded" });
  const source = page.locator("#page-1 canvas");
  const interactionLayer = page.locator("#page-1 [data-pdf-text-layer]");
  await expect(source).toBeVisible({ timeout: 20_000 });
  await expect(interactionLayer).toBeVisible({ timeout: 20_000 });
  const rotatedText = interactionLayer.getByText("Rotated text", { exact: true });
  await expect(rotatedText).toBeVisible();
  const textPresentationBeforeSelection = await rotatedText.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
    rotate: (element as HTMLElement).style.getPropertyValue("--rotate"),
    transform: getComputedStyle(element).transform,
    selectionColor: getComputedStyle(element, "::selection").color,
    selectionBackground: getComputedStyle(element, "::selection").backgroundColor,
    textLayerOpacity: getComputedStyle(element.closest(".textLayer")!).opacity,
  }));
  expect(textPresentationBeforeSelection.rotate).not.toBe("");
  expect(textPresentationBeforeSelection.selectionColor).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  expect(textPresentationBeforeSelection.selectionBackground).toBe("rgb(139, 26, 26)");
  expect(textPresentationBeforeSelection.textLayerOpacity).toBe("0.25");

  const copiedText = await rotatedText.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    let copied = "";
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { setData: (_type: string, value: string) => { copied = value; } },
    });
    element.dispatchEvent(event);
    return { copied, prevented: event.defaultPrevented };
  });
  expect(copiedText).toEqual({ copied: "Rotated text", prevented: true });
  await expect(interactionLayer).toHaveClass(/selecting/);
  expect(await rotatedText.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
    rotate: (element as HTMLElement).style.getPropertyValue("--rotate"),
    transform: getComputedStyle(element).transform,
    selectionColor: getComputedStyle(element, "::selection").color,
    selectionBackground: getComputedStyle(element, "::selection").backgroundColor,
    textLayerOpacity: getComputedStyle(element.closest(".textLayer")!).opacity,
  }))).toEqual(textPresentationBeforeSelection);
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(interactionLayer).not.toHaveClass(/selecting/);
  const canvasWidthBeforeZoom = await source.evaluate((canvas) => (canvas as HTMLCanvasElement).width);
  const toggle = page.getByRole("button", { name: "开启区域缩放" });
  const toolbarPosition = await toggle.boundingBox();
  expect(toolbarPosition).not.toBeNull();
  const expectToolbarPosition = async () => {
    const position = await page.getByRole("button", { name: /^(开启|关闭)区域缩放$/ }).boundingBox();
    expect(position).not.toBeNull();
    expect(position!.x).toBeCloseTo(toolbarPosition!.x, 0);
    expect(position!.y).toBeCloseTo(toolbarPosition!.y, 0);
  };
  await toggle.click();
  await expect(page.getByRole("button", { name: "关闭区域缩放" })).toHaveAttribute("aria-pressed", "true");
  const viewer = page.locator("[data-pdf-viewer]");
  await expect(viewer).toHaveAttribute("data-zoom", "1.5");
  await expectToolbarPosition();
  await expect(page.locator("[data-pdf-magnifier-lens]")).toHaveCount(0);
  const reader = page.locator("[data-reader-scroll-container]");
  const scrollHeightBeforeZoom = await reader.evaluate((element) => element.scrollHeight);
  const selectableText = interactionLayer.getByText("Page 1 selectable text", { exact: true });
  const selectableTextBox = await selectableText.boundingBox();
  expect(selectableTextBox).not.toBeNull();
  expect(await page.locator("[data-pdf-zoom-content]").evaluate((element) => (
    getComputedStyle(element).userSelect
  ))).not.toBe("none");
  if (browserName === "firefox") {
    expect(await selectableText.evaluate((element) => {
      const pointerDown = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: "mouse",
      });
      element.dispatchEvent(pointerDown);
      return pointerDown.defaultPrevented;
    })).toBe(false);
  } else {
    await page.mouse.move(selectableTextBox!.x + 2, selectableTextBox!.y + selectableTextBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      selectableTextBox!.x + selectableTextBox!.width - 2,
      selectableTextBox!.y + selectableTextBox!.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
  }
  await expect(viewer).toHaveAttribute("data-zoom", "1.5");
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });


  await interactionLayer.click({ position: { x: 300, y: 300 } });
  await expect(viewer).toHaveAttribute("data-zoom", "2");
  await expect(viewer).toHaveAttribute("data-render-zoom", "2");
  await expect.poll(() => source.evaluate((canvas) => (canvas as HTMLCanvasElement).width))
    .toBeGreaterThan(canvasWidthBeforeZoom);
  expect(await reader.evaluate((element) => element.scrollHeight)).toBeGreaterThan(scrollHeightBeforeZoom);
  await expect(page.getByText("正在加载第 1 页")).toHaveCount(0);

  const horizontalScroll = await reader.evaluate((element) => ({
    current: element.scrollLeft,
    maximum: element.scrollWidth - element.clientWidth,
  }));
  const panStart = await page.locator("#page-1").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const xCandidates = [0.8, 0.65, 0.5];
    const yCandidates = [0.75, 0.6, 0.45];
    for (const xRatio of xCandidates) {
      for (const yRatio of yCandidates) {
        const x = Math.min(window.innerWidth - 24, Math.max(24, rect.left + rect.width * xRatio));
        const y = Math.min(window.innerHeight - 24, Math.max(24, rect.top + rect.height * yRatio));
        const target = document.elementFromPoint(x, y);
        if (target && element.contains(target) && !target.closest("[data-pdf-text-layer] span")) {
          return { x, y };
        }
      }
    }
    throw new Error("No blank PDF page area is visible for the pan gesture");
  });
  const panDeltaX = horizontalScroll.current >= horizontalScroll.maximum / 2 ? 120 : -120;
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x + panDeltaX, panStart.y - 30, { steps: 5 });
  await page.mouse.up();
  expect(await reader.evaluate((element) => element.scrollLeft)).not.toBe(horizontalScroll.current);
  await expectToolbarPosition();

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(viewer).toHaveAttribute("data-zoom", "2.25");

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveAttribute("data-zoom", "1");
  await expect(page.getByRole("button", { name: "开启区域缩放" })).toHaveAttribute("aria-pressed", "false");
  await expectToolbarPosition();

  // Playwright exposes synthetic multi-touch through CDP only in Chromium.
  // WebKit/Firefox still cover layout zoom above; pointer logic has unit coverage.
  if (browserName !== "chromium") return;

  const zoomContent = page.locator("[data-pdf-zoom-content]");
  const zoomBox = await zoomContent.boundingBox();
  expect(zoomBox).not.toBeNull();
  const touchClient = await page.context().newCDPSession(page);
  await touchClient.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const centerX = zoomBox!.x + zoomBox!.width / 2;
  const centerY = zoomBox!.y + Math.min(320, zoomBox!.height / 2);
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: centerX - 50, y: centerY, id: 11 },
      { x: centerX + 50, y: centerY, id: 12 },
    ],
  });
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: centerX - 100, y: centerY, id: 11 },
      { x: centerX + 100, y: centerY, id: 12 },
    ],
  });
  await expect(viewer).toHaveAttribute("data-zoom", "2");
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: centerX - 50, y: centerY, id: 11 },
      { x: centerX + 50, y: centerY, id: 12 },
    ],
  });
  await expect(viewer).toHaveAttribute("data-zoom", "1");
  await touchClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const reopenedZoomButton = page.getByRole("button", { name: "开启区域缩放" });
  await expect(reopenedZoomButton).toHaveAttribute("aria-pressed", "false");
  await reopenedZoomButton.click();
  await expect(viewer).toHaveAttribute("data-zoom", "1.5");

  const scrollLeftBeforeTouchPan = await reader.evaluate((element) => element.scrollLeft);
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: centerX + 80, y: centerY, id: 13 }],
  });
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: centerX - 20, y: centerY, id: 13 }],
  });
  await touchClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await reader.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollLeftBeforeTouchPan);
});
