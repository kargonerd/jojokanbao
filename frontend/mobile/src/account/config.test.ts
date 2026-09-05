import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const { resolveAccountConfig } = createRequire(import.meta.url)("../../account-config.cjs");
const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jojo-account-config-"));
  directories.push(root);
  const mobile = join(root, "frontend", "mobile");
  mkdirSync(mobile, { recursive: true });
  writeFileSync(join(root, ".env.local"), 'VITE_SUPABASE_URL=https://example.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=public-key\nSUPABASE_SERVICE_ROLE_KEY=must-not-be-exposed\n');
  return mobile;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
describe("mobile account build config", () => {
  it("reads shared public configuration without exposing server credentials", () => {
    expect(resolveAccountConfig(fixture(), {})).toEqual({ supabaseUrl: "https://example.supabase.co", publishableKey: "public-key" });
  });
  it("prefers explicit Expo build variables", () => {
    expect(resolveAccountConfig(fixture(), { EXPO_PUBLIC_SUPABASE_URL: "https://mobile.supabase.co", EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "mobile-key" })).toEqual({ supabaseUrl: "https://mobile.supabase.co", publishableKey: "mobile-key" });
  });
  it("allows CI bundle checks without account settings", () => {
    const mobile = fixture();
    writeFileSync(join(mobile, "../../.env.local"), "");
    expect(resolveAccountConfig(mobile, { NODE_ENV: "production" })).toEqual({ supabaseUrl: "", publishableKey: "" });
  });
  it("rejects a release build with missing account settings", () => {
    const mobile = fixture();
    writeFileSync(join(mobile, "../../.env.local"), "");
    expect(() => resolveAccountConfig(mobile, { NODE_ENV: "production", JOJO_REQUIRE_ACCOUNT_CONFIG: "true" })).toThrow("Mobile account configuration missing");
  });
});
