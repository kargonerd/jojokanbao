import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function iosCacheContext(environment, xcode, macos, architecture, envFiles = {}) {
  const publicConfig = Object.entries(environment)
    .filter(([key]) => /^(EXPO_PUBLIC_|VITE_)/.test(key) || ["APP_VARIANT", "NODE_ENV", "BABEL_ENV", "JOJO_REQUIRE_ACCOUNT_CONFIG"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    config: hash([publicConfig, Object.entries(envFiles).sort(([left], [right]) => left.localeCompare(right))]),
    toolchain: hash([xcode.trim(), macos.trim(), architecture, environment.ImageOS, environment.ImageVersion]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Dotenv files are absent on normal CI checkouts, but must invalidate the
  // app if a later workflow introduces them. Only their digest is emitted.
  const envFiles = {};
  for (const directory of [".", "frontend/mobile"]) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(".env")) continue;
      envFiles[`${directory}/${entry.name}`] = readFileSync(`${directory}/${entry.name}`, "utf8");
    }
  }
  const context = iosCacheContext(process.env,
    execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }),
    execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }), process.arch, envFiles);
  const output = Object.entries(context).map(([key, value]) => `${key}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
