import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { classify } from "./affected.mjs";

function fixture() {
  return {
    manifest: { private: true, packageManager: "pnpm@9.12.2", pnpm: {} },
    lock: {
      lockfileVersion: "9.0",
      settings: { autoInstallPeers: true },
      importers: {
        ".": { devDependencies: { turbo: { specifier: "2", version: "2.0.0" } } },
        agent: { dependencies: { ai: { specifier: "1", version: "1.0.0" } } },
        "frontend/mobile": { dependencies: {
          react: { specifier: "1", version: "1.0.0(peer@1.0.0)" },
          ui: { specifier: "workspace:*", version: "link:../packages/ui" },
        } },
        "frontend/web": { dependencies: { ui: { specifier: "workspace:*", version: "link:../packages/ui" } } },
        "frontend/desktop": { devDependencies: { web: { specifier: "workspace:*", version: "link:../web" } } },
        "frontend/packages/ui": { dependencies: { content: { specifier: "workspace:*", version: "link:../content" } } },
        "frontend/packages/content": {},
      },
      packages: {
        "turbo@2.0.0": { resolution: { integrity: "root" } },
        "ai@1.0.0": { resolution: { integrity: "ai" } },
        "react@1.0.0": { resolution: { integrity: "react" } },
        "peer@1.0.0": { resolution: { integrity: "peer" } },
        "native@1.0.0": { resolution: { integrity: "native" } },
      },
      snapshots: {
        "turbo@2.0.0": {}, "ai@1.0.0": {},
        "react@1.0.0(peer@1.0.0)": { dependencies: { peer: "1.0.0" }, optionalDependencies: { native: "1.0.0" } },
        "peer@1.0.0": {}, "native@1.0.0": {},
      },
    },
  };
}

function check(files, mutate = () => {}, options = {}) {
  const before = fixture();
  const after = structuredClone(before);
  mutate(after, before);
  return classify({ files, before, after, ...options });
}

const consumerFlags = ["mobile_ios", "web_e2e", "desktop_e2e"];
function assertConsumers(result, expected) {
  for (const flag of consumerFlags) assert.equal(result.flags[flag], expected, flag);
}

test("Agent-only package rules, patch and lock changes skip unrelated consumers but retain Node checks", () => {
  const result = check(["agent/package.json", "agent/patches/ai.patch", "package.json", "pnpm-lock.yaml"], (after) => {
    after.manifest.pnpm.packageExtensions = { "ai@1.0.0": { peerDependenciesMeta: { coding: { optional: true } } } };
    after.manifest.pnpm.patchedDependencies = { "ai@1.0.0": "agent/patches/ai.patch" };
    after.lock.packageExtensionsChecksum = "new-checksum";
    after.lock.patchedDependencies = { "ai@1.0.0": { hash: "new", path: "agent/patches/ai.patch" } };
    after.lock.packages["ai@1.0.0"].resolution.integrity = "new-ai";
  });
  assert.equal(result.fallback, undefined);
  assertConsumers(result, false);
  assert.equal(result.flags.all_node, true);
  assert.equal(result.flags.node, true);
});

test("direct mobile code changes run native validation", () => {
  const result = check(["frontend/mobile/App.tsx"]);
  assert.equal(result.flags.mobile_ios, true);
  assert.equal(result.flags.web_e2e, false);
});

test("Archive publication changes retain their dedicated check without unrelated consumers", () => {
  for (const file of [
    "tools/archive-pdf/sync_rmrb.py",
    "tools/archive-pdf/tests/test_sync_rmrb.py",
    "tools/content-pipeline/jojo_format.py",
    "tools/jojo-admin/server/rmrb_review_publish.py",
    ".github/workflows/maintenance-sync-rmrb.yml",
  ]) {
    const result = check([file]);
    assert.equal(result.flags.archive_pdf, true, file);
    assertConsumers(result, false);
  }
  assert.equal(check([".github/workflows/ci.yml"]).flags.archive_pdf, true);
  assert.equal(check(["agent/src/runtime.ts"]).flags.archive_pdf, false);
  assert.equal(check(["README.md"]).flags.archive_pdf, false);
});

test("shared UI and transitive workspace sources trigger all their consumers", () => {
  assertConsumers(check(["frontend/packages/ui/src/Button.tsx"]), true);
  // An arbitrary new shared package is discovered from the dependency graph.
  const result = check(["frontend/packages/new-shared/index.ts"], (after, before) => {
    for (const state of [before, after]) {
      state.lock.importers["frontend/packages/content"] = { dependencies: { shared: { version: "link:../new-shared" } } };
      state.lock.importers["frontend/packages/new-shared"] = {};
    }
  });
  assertConsumers(result, true);
});

test("PostHog sync code and its workflow trigger Node checks", () => {
  for (const file of ["tools/posthog/sync-runtime-config.mjs", "tools/posthog/runtime-config-sql.test.mjs", ".github/workflows/sync-runtime-config.yml"]) {
    assert.equal(check([file]).flags.node, true, file);
  }
});

test("lockfile-only transitive updates, including optional packages and peers, trigger native build", () => {
  for (const key of ["native@1.0.0", "peer@1.0.0"]) {
    const result = check(["pnpm-lock.yaml"], (after) => {
      after.lock.packages[key].resolution.integrity = "changed";
    });
    assert.equal(result.flags.mobile_ios, true, key);
    assert.equal(result.flags.web_e2e, false, key);
  }
});

test("changed snapshot edges are followed even when the importer version is unchanged", () => {
  const result = check(["pnpm-lock.yaml"], (after) => {
    after.lock.packages["native@2.0.0"] = { resolution: { integrity: "v2" } };
    after.lock.snapshots["native@2.0.0"] = {};
    after.lock.snapshots["react@1.0.0(peer@1.0.0)"].optionalDependencies.native = "2.0.0";
  });
  assert.equal(result.flags.mobile_ios, true);
  assert.equal(result.fallback, undefined);
});

test("workspace dependency removals still test consumers against the previous graph", () => {
  const result = check(["frontend/mobile/package.json", "pnpm-lock.yaml"], (after) => {
    delete after.lock.importers["frontend/mobile"].dependencies.ui;
  });
  assert.equal(result.flags.mobile_ios, true);
});

test("patch source edits select consumers even before the lock hash is regenerated", () => {
  const result = check(["frontend/patches/native.patch"], (after, before) => {
    for (const state of [before, after]) {
      state.lock.patchedDependencies = { "native@1.0.0": { hash: "old", path: "frontend/patches/native.patch" } };
    }
  });
  assert.equal(result.flags.mobile_ios, true);
  assert.equal(result.flags.web_e2e, false);
  assert.equal(result.flags.desktop_e2e, false);
});

test("root build scripts, Node version, pnpm settings and root transitive dependencies invalidate consumers", () => {
  for (const mutate of [
    (after) => { after.manifest.scripts = { build: "new-build" }; },
    (after) => { after.manifest.engines = { node: ">=24" }; },
    (after) => { after.manifest.pnpm.onlyBuiltDependencies = ["react"]; },
    (after) => { after.lock.settings.autoInstallPeers = false; },
    (after) => { after.lock.packages["turbo@2.0.0"].resolution.integrity = "changed"; },
  ]) {
    const result = check(["package.json", "pnpm-lock.yaml"], mutate);
    assertConsumers(result, true);
    assert.equal(result.flags.all_node, true);
  }
});

test("CI helpers and global toolchain edits always validate every consumer", () => {
  for (const file of ["tools/ci/affected.mjs", ".github/workflows/ci.yml", "pnpm-workspace.yaml", "turbo.json", ".npmrc", ".pnpmfile.cjs"]) {
    assertConsumers(check([file]), true);
  }
});

test("missing or unsupported dependency metadata falls back to full checks", () => {
  for (const mutate of [
    (after) => { after.lock.lockfileVersion = "10.0"; },
    (after) => { delete after.lock.packages["peer@1.0.0"]; },
    (after) => { after.lock.importers["frontend/mobile"].dependencies.react.version = "unknown:resolution"; },
    (after) => { delete after.lock.importers["frontend/packages/content"]; },
  ]) {
    const result = check(["pnpm-lock.yaml"], mutate);
    assertConsumers(result, true);
    assert.ok(result.fallback);
  }
  assertConsumers(classify({ files: ["pnpm-lock.yaml"] }), true);
});

test("manual or initial-branch verification enables all checks", () => {
  const result = check([], () => {}, { forceAll: true });
  assert.ok(Object.values(result.flags).every(Boolean));
});

test("unchanged graphs and documentation skip consumer checks", () => {
  assertConsumers(check(["README.md"]), false);
  assertConsumers(check(["pnpm-lock.yaml"], (after) => {
    after.lock.packages["unreachable@1.0.0"] = { resolution: { integrity: "unused" } };
    after.lock.snapshots["unreachable@1.0.0"] = {};
  }), false);
});

test("package map ordering is irrelevant", () => {
  assertConsumers(check(["pnpm-lock.yaml"], (after) => {
    after.lock.packages = Object.fromEntries(Object.entries(after.lock.packages).reverse());
  }), false);
});

test("required checks remain stable and native validation uses its consumer flag", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.equal(workflow.jobs.required.name, "build-and-test");
  assert.equal(workflow.jobs["web-e2e"].name, "e2e");
  assert.ok(workflow.jobs.required.needs.includes("mobile-ios"));
  assert.ok(workflow.jobs.required.needs.includes("archive_pdf"));
  assert.equal(workflow.jobs.archive_pdf.if, "needs.changes.outputs.archive_pdf == 'true'");
  // Every workflow output must be supplied by the classifier, including flags
  // added on master after the classifier was introduced.
  const outputNames = Object.keys(workflow.jobs.changes.outputs)
    .filter((name) => !["base_sha", "head_sha"].includes(name)).sort();
  assert.deepEqual(Object.keys(check([]).flags).sort(), outputNames);
  assert.equal(workflow.jobs["mobile-ios"].if, "needs.changes.outputs.mobile_ios == 'true'");
  assert.ok(workflow.jobs.changes.steps.some((step) => step.run?.includes("pnpm --filter @jojo/ci test")));
  assert.ok(workflow.jobs["mobile-ios"].steps.some((step) => step.run?.includes("smoke-ios-simulator.sh")));
});
