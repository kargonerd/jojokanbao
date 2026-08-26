import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import type { CapturedHtmlPage } from "./http.js";

async function responseText(response: Response | null): Promise<string | undefined> {
  try {
    const contentType = (await response?.headerValue("content-type")) ?? "";
    if (!/(?:text\/html|application\/xhtml\+xml)/iu.test(contentType)) return undefined;
    return await response?.text();
  } catch {
    return undefined;
  }
}

export class BrowserSourceSession {
  readonly userDataDirectory: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly requireExtension: boolean;
  #extensionVerified = false;

  private constructor(userDataDirectory: string, context: BrowserContext, page: Page, requireExtension: boolean) {
    this.userDataDirectory = userDataDirectory;
    this.context = context;
    this.page = page;
    this.requireExtension = requireExtension;
  }

  static async open(options: { proxyServer?: string; extensionPath?: string; requireExtension: boolean }): Promise<BrowserSourceSession> {
    const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "jojo-times-chromium-"));
    const extensionArgs = options.extensionPath ? [
      `--disable-extensions-except=${options.extensionPath}`,
      `--load-extension=${options.extensionPath}`,
    ] : [];
    if (options.requireExtension && !options.extensionPath) throw new Error("BPC extension path is required by this source");
    try {
      const context = await chromium.launchPersistentContext(userDataDirectory, {
        headless: process.env.JOJO_TIMES_HEADLESS === "1",
        viewport: { width: 1440, height: 1200 },
        locale: "en-US",
        ignoreHTTPSErrors: true,
        ...(options.proxyServer ? { proxy: { server: options.proxyServer } } : {}),
        args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", ...extensionArgs],
      });
      const page = context.pages()[0] ?? await context.newPage();
      return new BrowserSourceSession(userDataDirectory, context, page, options.requireExtension);
    } catch (error) {
      await rm(userDataDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async capture(url: string, timeoutSeconds: number): Promise<CapturedHtmlPage> {
    const capturedAt = new Date().toISOString();
    try {
      let response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutSeconds * 1_000 });
      if (this.requireExtension && !this.#extensionVerified) {
        if (!this.context.serviceWorkers().some((worker) => worker.url().startsWith("chrome-extension://"))) {
          await this.context.waitForEvent("serviceworker", {
            predicate: (worker) => worker.url().startsWith("chrome-extension://"),
            timeout: 10_000,
          });
        }
        this.#extensionVerified = true;
      }
      await this.page.waitForTimeout(900);
      if ([401, 403, 429].includes(response?.status() ?? 0)) {
        await this.page.waitForTimeout(1_500);
        response = await this.page.reload({ waitUntil: "domcontentloaded", timeout: timeoutSeconds * 1_000 }).catch(() => response);
        await this.page.waitForTimeout(900);
      }
      const originalHtml = await responseText(response);
      const renderedHtml = await this.page.content();
      return {
        method: "browser",
        requestedUrl: url,
        finalUrl: this.page.url(),
        ...(response ? { status: response.status() } : {}),
        ...(originalHtml ? { originalHtml } : {}),
        renderedHtml,
        capturedAt,
      };
    } catch (error) {
      const renderedHtml = await this.page.content().catch(() => undefined);
      return {
        method: "browser",
        requestedUrl: url,
        finalUrl: this.page.url() || url,
        ...(renderedHtml ? { renderedHtml } : {}),
        capturedAt,
        error: error instanceof Error ? error.name : "BrowserFetchError",
      };
    }
  }

  async downloadAsset(url: string, referer: string, timeoutSeconds: number): Promise<{ body: Buffer; mediaType: string } | undefined> {
    try {
      const response = await this.context.request.get(url, {
        headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", referer },
        timeout: timeoutSeconds * 1_000,
        failOnStatusCode: false,
      });
      if (!response.ok()) return undefined;
      const body = await response.body();
      if (!body.length || body.length > 30_000_000) return undefined;
      return { body, mediaType: (response.headers()["content-type"] ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase() };
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await rm(this.userDataDirectory, { recursive: true, force: true });
  }
}
