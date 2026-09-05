const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { parseEnv } = require("node:util");

// Only these two public client settings may enter the application manifest.
function resolveAccountConfig(mobileRoot, environment = process.env) {
  const repositoryRoot = resolve(mobileRoot, "../..");
  const mode = environment.NODE_ENV || "development";
  const names = [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
  let root = repositoryRoot;
  if (!names.some((name) => existsSync(resolve(root, name)))) {
    try {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
      root = dirname(common);
    } catch { /* Source archives have no worktree metadata. */ }
  }
  const values = {};
  for (const directory of [root, mobileRoot]) {
    for (const name of names) {
      const path = resolve(directory, name);
      if (existsSync(path)) Object.assign(values, parseEnv(readFileSync(path, "utf8")));
    }
  }
  Object.assign(values, environment);
  const supabaseUrl = (environment.EXPO_PUBLIC_SUPABASE_URL || environment.VITE_SUPABASE_URL || values.EXPO_PUBLIC_SUPABASE_URL || values.VITE_SUPABASE_URL || "").trim();
  const publishableKey = (environment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || environment.VITE_SUPABASE_PUBLISHABLE_KEY || values.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || values.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim();
  // Release profiles require account settings; CI bundle checks can run without them.
  if (environment.JOJO_REQUIRE_ACCOUNT_CONFIG === "true" && (!supabaseUrl || !publishableKey)) {
    throw new Error("Mobile account configuration missing: set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY before building.");
  }
  return { supabaseUrl, publishableKey };
}
module.exports = { resolveAccountConfig };
