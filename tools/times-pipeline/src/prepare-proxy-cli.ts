import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { parseProxySubscription, serializeMihomoConfig } from "./proxy-config.js";

const MAXIMUM_SUBSCRIPTION_BYTES = 20_000_000;

async function downloadSubscription(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "mihomo" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAXIMUM_SUBSCRIPTION_BYTES) throw new Error();
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    throw new Error("Unable to download the configured proxy subscription");
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(requiredArg(args, "output"));
  const environmentName = args.get("subscription-env") ?? "JOJO_TIMES_PROXY_SUBSCRIPTION";
  const subscriptionUrl = process.env[environmentName]?.trim();
  if (!subscriptionUrl) throw new Error(`${environmentName} is not configured`);
  const subscription = parseProxySubscription(await downloadSubscription(subscriptionUrl));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serializeMihomoConfig(subscription), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`Prepared a temporary Mihomo configuration with ${subscription.proxies.length} nodes\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unable to prepare the proxy configuration"}\n`);
  process.exitCode = 1;
});
