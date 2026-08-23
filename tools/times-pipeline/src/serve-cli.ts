import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(requiredArg(args, "root"));
  const port = Number(args.get("port") ?? "4174");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535");

  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname).replace(/^\/+/, "");
      const target = path.resolve(root, ...pathname.split("/").filter(Boolean));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        response.writeHead(400).end("Invalid path");
        return;
      }
      const info = await stat(target);
      if (!info.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
      response.setHeader("Content-Type", target.endsWith(".jox") ? "application/octet-stream" : "application/json; charset=utf-8");
      response.setHeader("Content-Length", String(info.size));
      response.setHeader(
        "Cache-Control",
        pathname.endsWith("/index.jox") || pathname.endsWith("/manifest.jox") || pathname === "catalog.jox"
          ? "no-store"
          : "public, max-age=31536000, immutable",
      );
      response.writeHead(200);
      if (request.method === "HEAD") response.end();
      else createReadStream(target).pipe(response);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      response.writeHead(code === "ENOENT" ? 404 : 500).end(code === "ENOENT" ? "Not found" : "Server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  process.stdout.write(`Times Delivery: http://127.0.0.1:${port}/\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
