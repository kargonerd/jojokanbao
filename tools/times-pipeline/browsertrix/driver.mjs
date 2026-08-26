import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";

let extensionReady;

async function waitForExtension(page) {
  if (process.env.JOJO_REQUIRE_EXTENSION !== "1") return;
  extensionReady ??= (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const target = page.browser().targets().find((candidate) =>
        ["service_worker", "background_page"].includes(candidate.type())
          && candidate.url().startsWith("chrome-extension://")
      );
      if (target) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The configured Chromium extension did not start");
  })();
  await extensionReady;
}

export default async function jojoTimesDriver({ page, data, crawler, seed }) {
  await waitForExtension(page);
  let documentResponse;
  const onResponse = (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentResponse = response;
  };
  page.on("response", onResponse);
  try {
    await crawler.loadPage(page, data, seed);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const renderedHtml = await page.content();
    const originalHtml = await documentResponse?.text().catch(() => undefined);
    const maximumBytes = Number(process.env.JOJO_RENDERED_MAX_BYTES || "25000000");
    const name = createHash("sha256").update(data.url).digest("hex");
    await mkdir("/crawls/rendered", { recursive: true });
    if (Buffer.byteLength(renderedHtml, "utf8") <= maximumBytes) {
      await writeFile(`/crawls/rendered/${name}.html`, renderedHtml, "utf8");
    }
    if (originalHtml && Buffer.byteLength(originalHtml, "utf8") <= maximumBytes) {
      await writeFile(`/crawls/rendered/${name}.original.html`, originalHtml, "utf8");
    }
    await appendFile("/crawls/rendered/index.jsonl", `${JSON.stringify({
      seedUrl: data.url,
      finalUrl: page.url(),
      renderedFile: `${name}.html`,
      originalFile: originalHtml ? `${name}.original.html` : undefined,
      status: data.status,
      capturedAt: new Date().toISOString(),
    })}\n`);
  } finally {
    page.off("response", onResponse);
  }
}
