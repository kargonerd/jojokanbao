import assert from "node:assert/strict";
import test from "node:test";
import { catalogCacheIsSafe, corsAllowsOrigin } from "./verify-release-cdn.mjs";

test("accepts only short-lived catalog cache policies", () => {
  assert.equal(catalogCacheIsSafe("public, max-age=60"), true);
  assert.equal(catalogCacheIsSafe("no-cache"), true);
  assert.equal(catalogCacheIsSafe("public, max-age=864000"), false);
  assert.equal(catalogCacheIsSafe("max-age=60, s-maxage=864000"), false);
  assert.equal(catalogCacheIsSafe(undefined), false);
});

test("validates the Reader Web CORS origin", () => {
  assert.equal(corsAllowsOrigin("https://reader.jojokanbao.cn", "https://reader.jojokanbao.cn"), true);
  assert.equal(corsAllowsOrigin("*", "https://reader.jojokanbao.cn"), true);
  assert.equal(corsAllowsOrigin("https://example.com", "https://reader.jojokanbao.cn"), false);
});
