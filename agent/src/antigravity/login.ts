import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loginAntigravity as packageLogin } from "pi-antigravity/src/auth/oauth.js";
import type { OAuthCredential, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { JsonCredentialStore } from "../credentials";
import { resolveLocalAgentAuthPath } from "../local-codex-credential";

export async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredential> {
  const credential = await packageLogin(callbacks);
  if (!credential.access?.trim() || !credential.refresh?.trim()
    || !Number.isFinite(credential.expires)) {
    throw new Error("Antigravity OAuth returned incomplete credentials");
  }
  return { ...credential, type: "oauth" };
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  const readline = process.stdin.isTTY && !process.argv.includes("--browser-only")
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  try {
    const credential = await loginAntigravity({
      signal: controller.signal,
      onAuth: ({ url }) => process.stdout.write(`请在 15 分钟内于本机浏览器完成 Google 登录，并保持此进程运行：\n${url}\n`),
      onProgress: (message) => process.stdout.write(`${message}\n`),
      onDeviceCode: () => { throw new Error("Unexpected device-code login"); },
      onSelect: async () => undefined,
      onPrompt: async ({ message }) => readline
        ? readline.question(`${message}\n`, { signal: controller.signal })
        : new Promise<string>(() => undefined),
    });
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const authPath = resolveLocalAgentAuthPath(root, process.env);
    await new JsonCredentialStore(authPath).modify("antigravity", async () => credential);
    process.stdout.write(`Antigravity 登录成功，凭据已保存到 ${authPath}。运行时会自动刷新。\n`);
  } finally {
    controller.abort();
    readline?.close();
    process.removeListener("SIGINT", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const oauthCode = ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "invalid_scope"]
      .find((code) => message.includes(code));
    const hint = message.includes("timed out waiting for browser")
      ? "登录等待已超时，回调监听已关闭。请重新运行 auth:antigravity，使用新链接登录。"
      : message.includes("Port 51121 is already in use")
        ? "51121 端口已有登录进程，请完成或关闭上一轮登录后重试。"
        : message.includes("state mismatch") || message.includes("State mismatch")
          ? "此回调属于旧登录流程，请重新运行 auth:antigravity 并使用最新链接。"
          : oauthCode
            ? `Google 授权失败（${oauthCode}），请使用新链接重试。`
            : message.includes("No refresh token received")
              ? "Google 没有返回离线刷新凭据，请重新授权并允许离线访问。"
              : message.includes("fetch failed") || message.includes("timed out")
                ? "连接 Google 令牌服务失败或超时，请检查此电脑的网络/代理后重试。"
                : message.includes("cancelled") || message.includes("aborted")
                  ? "登录已取消。"
                  : "登录未完成，请检查浏览器授权或网络，然后重新运行 auth:antigravity。";
    process.stderr.write(`Antigravity：${hint}\n`);
    process.exitCode = 1;
  });
}
