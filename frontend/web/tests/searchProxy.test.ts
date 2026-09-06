// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createSearchProxy } from "../../tooling/search-proxy";

interface UpstreamRequest {
  method: string | undefined;
  path: string | undefined;
  host: string | undefined;
  contentType: string | undefined;
  body: string;
}

const upstreamRequests: UpstreamRequest[] = [];
const searchResult = { data: { total: 1, results: [{ title: "刘少奇文献" }] } };
const unavailableResult = { error: "search backend is not configured" };
const upstream = createHttpServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  upstreamRequests.push({
    method: request.method,
    path: request.url,
    host: request.headers.host,
    contentType: request.headers["content-type"],
    body: Buffer.concat(chunks).toString("utf8"),
  });
  const unavailable = request.url?.includes("unavailable");
  response.writeHead(unavailable ? 503 : 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(unavailable ? unavailableResult : searchResult));
});

let vite: ViteDevServer | undefined;
let proxyOrigin: string;
let upstreamHost: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Missing upstream address");
  upstreamHost = `127.0.0.1:${upstreamAddress.port}`;
  vite = await createServer({
    configFile: false,
    envFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      hmr: false,
      watch: null,
      proxy: createSearchProxy(`http://${upstreamHost}`),
    },
  });
  await vite.listen();
  const proxyAddress = vite.httpServer?.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing proxy address");
  proxyOrigin = `http://127.0.0.1:${proxyAddress.port}`;
});

afterAll(async () => {
  await vite?.close();
  if (upstream.listening) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => error ? reject(error) : resolve());
    });
  }
});

describe("development search proxy", () => {
  it.each([
    { scenario: "success", status: 200, result: searchResult },
    { scenario: "unavailable", status: 503, result: unavailableResult },
  ])("forwards POST paths and bodies and preserves a $status response", async ({ scenario, status, result }) => {
    const payload = { query: "刘少奇", datasetIds: ["rmrb"], types: ["newspaper"], page: 1, size: 10 };
    const response = await fetch(`${proxyOrigin}/search-api/content/search?scenario=${scenario}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: proxyOrigin },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(result);
    expect(upstreamRequests.at(-1)).toEqual({
      method: "POST",
      path: `/content/search?scenario=${scenario}`,
      host: upstreamHost,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  it("forwards legacy GET searches with the complete query string", async () => {
    const query = new URLSearchParams({
      keyword: "刘少奇",
      page: "2",
      size: "10",
      sort: "timeDesc",
      startDate: "1966-07-01",
      endDate: "1966-07-31",
    }).toString();
    const response = await fetch(`${proxyOrigin}/search-api/search?${query}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(searchResult);
    expect(upstreamRequests.at(-1)).toEqual({
      method: "GET",
      path: `/search?${query}`,
      host: upstreamHost,
      contentType: undefined,
      body: "",
    });
  });

  it("does not proxy paths outside the search-api prefix", async () => {
    const initialRequestCount = upstreamRequests.length;
    const response = await fetch(`${proxyOrigin}/search-api-extra/content/search`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(upstreamRequests).toHaveLength(initialRequestCount);
  });
});
