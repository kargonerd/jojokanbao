// @vitest-environment node
import { createServer as createHttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createSpeechProxy } from "../../tooling/speech-proxy";

const requests: Array<{ path?: string; method?: string; body: string }> = [];
const upstream = createHttpServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ path: request.url, method: request.method, body: Buffer.concat(chunks).toString("utf8") });
  response.writeHead(request.url?.includes("unavailable") ? 503 : 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});
let vite: ViteDevServer | undefined;
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  vite = await createServer({ configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null,
      proxy: createSpeechProxy(`http://127.0.0.1:${address.port}/v1`) } });
  await vite.listen();
  const proxy = vite.httpServer?.address();
  if (!proxy || typeof proxy === "string") throw new Error("Missing proxy port");
  origin = `http://127.0.0.1:${proxy.port}`;
});

afterAll(async () => {
  await vite?.close();
  if (upstream.listening) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

describe("development listening proxy", () => {
  it("uses the existing online Reader by default", () => {
    const proxy = Object.values(createSpeechProxy())[0]!;
    expect(proxy.target).toBe("https://beta.jojokanbao.cn");
    expect(proxy.rewrite("/api/v1/speech/providers?v=2")).toBe("/api/v1/speech/providers?v=2");
  });

  it.each(["/providers?v=2", "/stream/?ticket=example", "/providers?unavailable"])("preserves provider and stream paths: %s", async (path) => {
    const result = await fetch(`${origin}/api/v1/speech${path}`);
    expect(result.status).toBe(path.includes("unavailable") ? 503 : 200);
    expect(requests.at(-1)).toEqual({ path: `/v1/speech${path}`, method: "GET", body: "" });
  });

  it("forwards speech generation parameters and leaves unrelated API routes alone", async () => {
    const body = JSON.stringify({ text: "正文", voice: "male", provider: "auto" });
    const result = await fetch(`${origin}/api/v1/speech?stream=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(result.status).toBe(200);
    expect(requests.at(-1)).toEqual({ path: "/v1/speech?stream=true", method: "POST", body });
    const count = requests.length;
    expect((await fetch(`${origin}/api/v1/speech-extra`)).status).toBe(404);
    expect(requests).toHaveLength(count);
  });
});
