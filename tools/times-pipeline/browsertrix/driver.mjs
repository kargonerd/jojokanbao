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
      if (target) {
        await writeFile("/crawls/extension-ready.json", `${JSON.stringify({
          verifiedAt: new Date().toISOString(),
          target: target.url().replace(/^(chrome-extension:\/\/[^/]+).*/u, "$1"),
        })}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The configured Chromium extension did not start");
  })();
  await extensionReady;
}

export default async function jojoTimesDriver({ page, data, crawler, seed }) {
  await waitForExtension(page);
  try {
    await crawler.loadPage(page, data, seed);
  } catch {
    // Browsertrix may time out after the document has rendered enough to archive.
    // Preserve that DOM and let the caller judge its HTTP status and body quality.
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  const html = await page.content();
  const maximumBytes = Number(process.env.JOJO_RENDERED_MAX_BYTES || "25000000");
  if (Buffer.byteLength(html, "utf8") > maximumBytes) return;
  const name = createHash("sha256").update(data.url).digest("hex");
  await mkdir("/crawls/rendered", { recursive: true });
  await writeFile(`/crawls/rendered/${name}.html`, html, "utf8");
  await appendFile("/crawls/rendered/index.jsonl", `${JSON.stringify({
    seedUrl: data.url,
    finalUrl: page.url(),
    file: `${name}.html`,
    status: data.status,
    capturedAt: new Date().toISOString(),
  })}\n`);
}
