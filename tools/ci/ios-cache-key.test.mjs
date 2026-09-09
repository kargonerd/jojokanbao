import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { iosCacheContext } from "./ios-cache-key.mjs";

const environment = { APP_VARIANT: "standard", EXPO_PUBLIC_SUPABASE_URL: "https://account.example", ImageVersion: "image-1" };
const context = (env = environment, xcode = "Xcode 26.6", os = "26.5", arch = "arm64", files = {}) => iosCacheContext(env, xcode, os, arch, files);

test("client settings and dotenv changes invalidate the compiled app without exposing values", () => {
  for (const key of ["APP_VARIANT", "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_AGENT_API_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "NODE_ENV"]) {
    assert.notEqual(context({ ...environment, [key]: "changed" }).config, context().config, key);
  }
  assert.notEqual(context(environment, undefined, undefined, undefined, { ".env": "EXPO_PUBLIC_KEY=secret" }).config, context().config);
  assert.match(context().config, /^[a-f0-9]{64}$/);
});

test("Xcode, macOS, architecture and runner image changes invalidate the binary", () => {
  for (const changed of [context(environment, "new Xcode"), context(environment, undefined, "new macOS"),
    context(environment, undefined, undefined, "x64"), context({ ...environment, ImageVersion: "image-2" })]) {
    assert.notEqual(changed.toolchain, context().toolchain);
  }
});

test("branch updates and environment ordering do not invalidate identical build inputs", () => {
  assert.deepEqual(context({ GITHUB_SHA: "another-commit", ...environment }), context());
  assert.deepEqual(context(Object.fromEntries(Object.entries(environment).reverse())), context());
});

test("cache hashes sources before install, saves only a successful compile, and always runs smoke tests", () => {
  const steps = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")).jobs["mobile-ios"].steps;
  const restore = steps.find((step) => step.id === "ios_app_cache");
  const save = steps.find((step) => step.name === "Save compiled iOS app");
  const compile = steps.find((step) => step.name === "Compile iOS Release for Simulator");
  const smoke = steps.find((step) => step.name === "Launch Release app in iOS Simulator");
  assert.ok(steps.indexOf(restore) < steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile"));
  for (const input of ["frontend/mobile/**", "frontend/packages/**", "frontend/tooling/**", "frontend/patches/**", "pnpm-lock.yaml", "package.json", ".github/workflows/ci.yml", "tools/ci/**", "ios_cache_context.outputs.config", "ios_cache_context.outputs.toolchain"]) {
    assert.ok(restore.with.key.includes(input), input);
  }
  assert.equal(restore.with["restore-keys"], undefined);
  assert.match(restore.with.path, /\/Release-iphonesimulator\/JOJO\.app$/);
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.if, "steps.ios_app_cache.outputs.cache-hit != 'true'");
  assert.equal(compile.if, save.if);
  assert.ok(steps.indexOf(compile) < steps.indexOf(save));
  assert.ok(steps.indexOf(save) < steps.indexOf(smoke));
  assert.equal(smoke.if, undefined);
  assert.equal(steps.find((step) => step.name === "Verify pinned Hermes fallback").if, undefined);
});
