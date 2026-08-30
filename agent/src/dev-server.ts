import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRagAgentDefinition, createTimesAgentDefinition } from "./applications";
import { PersistentCredentialStore, type CredentialFile } from "./credentials";
import { createEdgeOneAgentHandler } from "./edgeone/handler";
import { createPlatformModelRuntime, resolvePlatformModelConfig, type AgentEnvironment } from "./models";
import { loadLocalCodexCredential } from "./local-codex-credential";
import { createRagTools } from "./rag-tools";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
// Times explanations can include up to 4 MB of decoded image data. Base64 and
// JSON framing make the HTTP payload larger than that, so keep the local limit
// aligned with the production handler instead of dropping image requests.
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;

function developmentEnvironmentDirectory(): string {
  if ([".env", ".env.local"].some((name) => existsSync(path.join(repositoryRoot, name)))) {
    return repositoryRoot;
  }
  try {
    const commonGitDirectory = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
    ).trim();
    const primaryWorktree = path.resolve(path.dirname(commonGitDirectory));
    if (
      primaryWorktree !== repositoryRoot
      && [".env", ".env.local"].some((name) => existsSync(path.join(primaryWorktree, name)))
    ) {
      return primaryWorktree;
    }
  } catch {
    // Source archives may not expose Git worktree metadata.
  }
  return repositoryRoot;
}

function parsedEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const separator = trimmed.indexOf("=");
  if (separator < 1) return undefined;
  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? [key, value] : undefined;
}

async function developmentEnvironment(): Promise<AgentEnvironment> {
  const values: Record<string, string | undefined> = {};
  const environmentDirectory = developmentEnvironmentDirectory();
  for (const name of [".env", ".env.local"]) {
    try {
      const content = await readFile(path.join(environmentDirectory, name), "utf8");
      for (const line of content.split(/\r?\n/)) {
        const parsed = parsedEnvLine(line);
        if (parsed) values[parsed[0]] = parsed[1];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    ...values,
    ...process.env,
    JOJO_CONTENT_CDN_BASE: process.env.JOJO_CONTENT_CDN_BASE?.trim()
      || values.JOJO_CONTENT_CDN_BASE?.trim()
      || "https://blacknews.jojokanbao.cn/",
  };
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.flushHeaders();
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!target.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => target.once("drain", resolve));
    }
  }
  target.end();
}

const environment = await developmentEnvironment();
const { credential, source } = await loadLocalCodexCredential(repositoryRoot, environment);
let credentialFile: CredentialFile = { "openai-codex": credential };
const credentialStore = new PersistentCredentialStore({
  read: async () => credentialFile,
  write: async (next) => { credentialFile = next; },
});
const ragDefinition = createRagAgentDefinition();
const timesDefinition = createTimesAgentDefinition();
const createModelRuntime = () => createPlatformModelRuntime({
  config: resolvePlatformModelConfig(environment),
  environment,
  credentials: credentialStore,
});
const handleRagAgent = createEdgeOneAgentHandler({
  agentId: ragDefinition.id,
  systemPrompt: ragDefinition.systemPrompt,
  createModelRuntime,
  tools(_context, _user, body) {
    return createRagTools({
      contentCdnBase: environment.JOJO_CONTENT_CDN_BASE!,
      scope: body.scope,
      focus: body.focus,
    });
  },
});
const handleTimesAgent = createEdgeOneAgentHandler({
  agentId: timesDefinition.id,
  systemPrompt: timesDefinition.systemPrompt,
  createModelRuntime,
});
const port = Number(environment.JOJO_AGENT_DEV_PORT ?? "8789");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("JOJO_AGENT_DEV_PORT must be a valid port");
}

const server = createServer(async (request, response) => {
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
    const headers = requestHeaders(request);
    let result: Response;
    if ((url.pathname === "/rag" || url.pathname === "/times") && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        result = Response.json({ error: "问答请求格式无效" }, { status: 400 });
        await writeResponse(result, response);
        return;
      }
      const handleAgent = url.pathname === "/times" ? handleTimesAgent : handleRagAgent;
      result = await handleAgent({
        env: environment,
        conversation_id: headers.get("Makers-Conversation-Id") ?? undefined,
        request: {
          body,
          headers,
          signal: abortController.signal,
        },
      });
    } else if (["/health", "/rag/health", "/times/health"].includes(url.pathname)) {
      result = Response.json({ ok: true, model: resolvePlatformModelConfig(environment).model });
    } else {
      result = Response.json({ error: "Not found" }, { status: 404 });
    }
    await writeResponse(result, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const status = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 500;
    await writeResponse(Response.json({
      error: status === 413 ? "问答内容过长" : "本地问答服务失败",
    }, { status }), response);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write([
    `JOJO local agents listening on http://127.0.0.1:${port} (/rag, /times)`,
    `Codex OAuth: ${path.relative(repositoryRoot, source) || source}`,
    `Content CDN: ${environment.JOJO_CONTENT_CDN_BASE}`,
    "",
  ].join("\n"));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
