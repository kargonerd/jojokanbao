import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("ships the current reader implementation as source for native production bundles", () => {
  expect(() => execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/generate-speech-reader.mjs", import.meta.url)), "--check"])).not.toThrow();
}, 30_000);
