import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapturedHtmlPage } from "./http.js";

export const BROWSERTRIX_IMAGE = "webrecorder/browsertrix-crawler:1.14.1@sha256:591ee8b591fd1aed8983ffce08be1b16fb7a850239969aa364bff17cfbdb4588";

export interface BrowsertrixArticle {
  articleId: string;
  captureUrl: string;
}

export interface BrowsertrixBatchOptions {
  articles: BrowsertrixArticle[];
  driverPath: string;
  timeoutSeconds: number;
  image?: string;
  proxyServer?: string;
  extensionPath?: string;
  requireExtension: boolean;
  temporaryRoot?: string;
}

interface RenderedIndexRow {
  seedUrl?: string;
  finalUrl?: string;
  renderedFile?: string;
  originalFile?: string;
  status?: number;
  capturedAt?: string;
}

function jsonLines<T>(value: string): T[] {
  return value.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

async function readOptional(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeChild(root: string, name: string | undefined): string | undefined {
  return name && path.basename(name) === name ? path.join(root, name) : undefined;
}

async function runDocker(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && output.trim()) process.stderr.write(`[browsertrix] exit ${exitCode}\n${output.trim()}\n`);
      resolve(exitCode);
    });
  });
}

export function browsertrixArguments(options: BrowsertrixBatchOptions, temporaryRoot: string): string[] {
  if (options.requireExtension && !options.extensionPath) throw new Error("BPC extension path is required by this source");
  const args = [
    "run",
    "--rm",
    "--network=host",
    "--volume", `${path.resolve(temporaryRoot)}:/crawls`,
    "--volume", `${path.resolve(options.driverPath)}:/jojo/driver.mjs:ro`,
    "--env", "JOJO_RENDERED_MAX_BYTES=25000000",
  ];
  if (options.extensionPath) {
    args.push(
      "--volume", `${path.resolve(options.extensionPath)}:/jojo/bpc:ro`,
      "--env", "JOJO_REQUIRE_EXTENSION=1",
    );
  }
  args.push(
    options.image ?? BROWSERTRIX_IMAGE,
    "xvfb-run",
    "--server-num=99",
    "--server-args=-screen 0 1360x1020x16 -ac -nolisten tcp",
    "crawl",
    "--seedFile=/crawls/seeds.txt",
    "--collection=transient",
    "--scopeType=page",
    `--pageLimit=${options.articles.length}`,
    "--workers=1",
    `--pageLoadTimeout=${options.timeoutSeconds}`,
    "--waitUntil=domcontentloaded",
    "--postLoadDelay=1",
    "--behaviors=",
    "--maxPageRetries=0",
    "--rateLimitMaxRetries=0",
    "--diskUtilization=0",
    "--saveState=never",
    "--overwrite",
    "--driver=/jojo/driver.mjs",
  );
  if (options.proxyServer) args.push(`--proxyServer=${options.proxyServer}`);
  if (options.extensionPath) {
    args.push(
      "--extraChromeArgs=--disable-extensions-except=/jojo/bpc",
      "--extraChromeArgs=--load-extension=/jojo/bpc",
    );
  }
  return args;
}

export async function captureBrowsertrixBatch(options: BrowsertrixBatchOptions): Promise<Map<string, CapturedHtmlPage>> {
  if (!options.articles.length) return new Map();
  const temporaryRoot = await mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "jojo-times-browsertrix-"));
  try {
    await writeFile(path.join(temporaryRoot, "seeds.txt"), `${options.articles.map((article) => article.captureUrl).join("\n")}\n`);
    const exitCode = await runDocker(browsertrixArguments(options, temporaryRoot));
    const renderedRoot = path.join(temporaryRoot, "rendered");
    const rows = jsonLines<RenderedIndexRow>((await readOptional(path.join(renderedRoot, "index.jsonl"))) ?? "");
    const bySeed = new Map(rows.flatMap((row) => row.seedUrl ? [[row.seedUrl, row] as const] : []));
    return new Map(await Promise.all(options.articles.map(async (article): Promise<[string, CapturedHtmlPage]> => {
      const row = bySeed.get(article.captureUrl);
      const renderedTarget = safeChild(renderedRoot, row?.renderedFile);
      const originalTarget = safeChild(renderedRoot, row?.originalFile);
      const renderedHtml = renderedTarget ? await readOptional(renderedTarget) : undefined;
      const originalHtml = originalTarget ? await readOptional(originalTarget) : undefined;
      return [article.articleId, {
        method: "browser",
        requestedUrl: article.captureUrl,
        finalUrl: row?.finalUrl ?? article.captureUrl,
        ...(row?.status !== undefined ? { status: row.status } : {}),
        ...(originalHtml ? { originalHtml } : {}),
        ...(renderedHtml ? { renderedHtml } : {}),
        capturedAt: row?.capturedAt ?? new Date().toISOString(),
        ...(!renderedHtml ? { error: exitCode === 0 ? "BrowsertrixMissingPage" : `BrowsertrixExit${exitCode}` } : {}),
      }];
    })));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
