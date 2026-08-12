#!/usr/bin/env node
import path from "node:path";
import { mergeDeliveryMetadata } from "./merge-delivery";

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index]!, process.argv[index + 1]!);
}
const localRoot = values.get("--local");
const remoteRoot = values.get("--remote");
const outputRoot = values.get("--output");
if (!localRoot || !remoteRoot || !outputRoot) {
  throw new Error("Usage: merge-delivery --local <delivery> --remote <metadata> --output <metadata>");
}
const result = await mergeDeliveryMetadata({
  localRoot: path.resolve(localRoot),
  remoteRoot: path.resolve(remoteRoot),
  outputRoot: path.resolve(outputRoot),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
