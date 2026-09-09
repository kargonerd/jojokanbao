import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { commitHealthyProxyCache, prepareProxyConfiguration } from "./prepare-proxy.js";
import { hfProxyCacheStore } from "./proxy-subscription-store.js";
import { selectProxySubscription } from "./proxy-subscription-rotation.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(requiredArg(args, "output"));
  const environmentName = args.get("subscription-env") ?? "JOJO_TIMES_PROXY_SUBSCRIPTION";
  const subscriptionUrl = process.env[environmentName]?.trim();
  if (!subscriptionUrl) throw new Error(`${environmentName} is not configured`);
  const selected = selectProxySubscription({ primary: subscriptionUrl,
    secondary: process.env[`${environmentName}_2`], runNumber: process.env.GITHUB_RUN_NUMBER,
    rotationOffset: args.get("rotation-offset") });
  const bucket = args.get("cache-bucket");
  const secret = process.env.HF_TOKEN?.trim() ?? "";
  const options = { url: selected.url, output,
    ...(bucket ? { cache: { store: hfProxyCacheStore(bucket, secret, selected.slot), secret } } : {}) };
  const action = args.get("action") ?? "prepare";
  if (action === "commit-cache") {
    await commitHealthyProxyCache(options);
    return;
  }
  if (action !== "prepare") throw new Error("Unknown proxy preparation action");
  const report = { ...await prepareProxyConfiguration(options), subscriptionIndex: selected.slot + 1,
    subscriptionCount: selected.count, rotationOffset: selected.rotationOffset };
  if (args.get("report")) {
    await writeFile(path.resolve(args.get("report")!), `${JSON.stringify(report)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`Prepared a temporary Mihomo configuration with ${report.nodes} nodes (${report.source}; subscription ${report.subscriptionIndex}/${report.subscriptionCount})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unable to prepare the proxy configuration"}\n`);
  process.exitCode = 1;
});
