import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArchiveArticle } from "./select.js";

export const BROWSERTRIX_IMAGE = "webrecorder/browsertrix-crawler:1.14.1@sha256:591ee8b591fd1aed8983ffce08be1b16fb7a850239969aa364bff17cfbdb4588";

interface BrowsertrixPage {
  url?: string;
  ts?: string;
  title?: string;
  status?: number;
  text?: string;
}

interface RenderedIndexRow {
  seedUrl?: string;
  finalUrl?: string;
  file?: string;
  status?: number;
  capturedAt?: string;
}

export interface BrowsertrixCapture {
  articleId: string;
  sourceId: string;
  title: string;
  captureUrl: string;
  finalUrl?: string;
  status?: number;
  capturedAt?: string;
  renderedHtml?: string;
  waczObject: string;
  error?: string;
}

export interface BrowsertrixAttempt {
  round: number;
  exitCode: number;
  waczObject: string;
  waczBytes: number;
  captures: BrowsertrixCapture[];
}

export interface BrowsertrixRunOptions {
  image?: string;
  workspace: string;
  temporaryRoot: string;
  rawArchiveRoot: string;
  runId: string;
  round: number;
  articles: ArchiveArticle[];
  workers: number;
  timeoutSeconds: number;
  proxyServer?: string;
  extensionPath?: string;
  driverPath: string;
}

function jsonLines<T>(value: string): T[] {
  return value.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line) as T & { format?: unknown };
      return row.format === "json-pages-1.0" ? [] : [row];
    } catch {
      return [];
    }
  });
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  try {
    return jsonLines<T>(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function urlKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href;
  } catch {
    return value;
  }
}

async function runDocker(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export function browsertrixArguments(options: BrowsertrixRunOptions): string[] {
  const args = [
    "run",
    "--rm",
    "--network=host",
    "--volume", `${path.resolve(options.temporaryRoot)}:/crawls`,
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
    "crawl",
    "--seedFile=/crawls/seeds.txt",
    "--collection=capture",
    "--scopeType=page",
    `--pageLimit=${options.articles.length}`,
    `--workers=${options.workers}`,
    `--pageLoadTimeout=${options.timeoutSeconds}`,
    "--waitUntil=domcontentloaded",
    "--postLoadDelay=1",
    "--behaviors=",
    "--maxPageRetries=0",
    "--rateLimitMaxRetries=0",
    "--diskUtilization=0",
    "--saveState=never",
    "--text=to-pages",
    "--generateWACZ",
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

export async function runBrowsertrixAttempt(options: BrowsertrixRunOptions): Promise<BrowsertrixAttempt> {
  await mkdir(options.temporaryRoot, { recursive: true });
  await writeFile(path.join(options.temporaryRoot, "seeds.txt"), `${options.articles.map((article) => article.captureUrl).join("\n")}\n`);
  const exitCode = await runDocker(browsertrixArguments(options));
  const collection = path.join(options.temporaryRoot, "collections", "capture");
  const generatedWacz = path.join(collection, "capture.wacz");
  const archiveDirectory = path.join(options.rawArchiveRoot, ...new Date().toISOString().slice(0, 10).split("-"), options.runId);
  await mkdir(archiveDirectory, { recursive: true });
  const archiveName = `browsertrix-${String(options.round).padStart(2, "0")}.wacz`;
  const archiveFile = path.join(archiveDirectory, archiveName);
  try {
    await copyFile(generatedWacz, archiveFile);
  } catch (error) {
    throw new Error(`Browsertrix did not produce a WACZ (exit ${exitCode}): ${(error as Error).message}`);
  }
  const waczObject = path.relative(options.workspace, archiveFile).replaceAll(path.sep, "/");
  const pages = await readJsonLines<BrowsertrixPage>(path.join(collection, "pages", "pages.jsonl"));
  const pagesByUrl = new Map(pages.flatMap((page) => {
    const key = urlKey(page.url);
    return key ? [[key, page] as const] : [];
  }));
  const renderedRoot = path.join(options.temporaryRoot, "rendered");
  const rendered = await readJsonLines<RenderedIndexRow>(path.join(renderedRoot, "index.jsonl"));
  const renderedBySeed = new Map(rendered.flatMap((row) => row.seedUrl ? [[row.seedUrl, row] as const] : []));
  const captures = await Promise.all(options.articles.map(async (article): Promise<BrowsertrixCapture> => {
    const renderedRow = renderedBySeed.get(article.captureUrl);
    const page = pagesByUrl.get(urlKey(renderedRow?.finalUrl) ?? "") ?? pagesByUrl.get(urlKey(article.captureUrl) ?? "");
    let renderedHtml: string | undefined;
    if (renderedRow?.file && path.basename(renderedRow.file) === renderedRow.file) {
      try {
        renderedHtml = await readFile(path.join(renderedRoot, renderedRow.file), "utf8");
      } catch {
        // Missing rendered DOM is represented as a capture error below.
      }
    }
    const status = renderedRow?.status ?? page?.status;
    const finalUrl = renderedRow?.finalUrl ?? page?.url;
    const capturedAt = renderedRow?.capturedAt ?? page?.ts;
    const succeeded = status !== undefined && status >= 200 && status < 400 && Boolean(renderedHtml);
    return {
      articleId: article.articleId,
      sourceId: article.sourceId,
      title: article.title,
      captureUrl: article.captureUrl,
      ...(finalUrl ? { finalUrl } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(capturedAt ? { capturedAt } : {}),
      ...(renderedHtml ? { renderedHtml } : {}),
      waczObject,
      ...(!succeeded ? { error: status === undefined ? "BrowsertrixMissingPage" : `HTTPStatus${status}` } : {}),
    };
  }));
  return {
    round: options.round,
    exitCode,
    waczObject,
    waczBytes: (await stat(archiveFile)).size,
    captures,
  };
}
