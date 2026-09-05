import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { parseProxySubscription, serializeMihomoConfig } from "./proxy-config.js";
import { downloadSubscription } from "./proxy-subscription.js";

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
