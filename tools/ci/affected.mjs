import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

const patterns = {
  archive_pdf: /^(tools\/(archive-pdf\/|content-pipeline\/jojo_format\.py$|jojo-admin\/server\/rmrb_review_publish\.py$)|\.github\/workflows\/(ci|maintenance-sync-rmrb)\.yml$)/,
  node: /^(agent\/|frontend\/|infrastructure\/(cloudflare\/|tencent-scf\/maintenance-scheduler\/)|tools\/(ci\/|posthog\/|monitoring\/|maintenance-scheduler\/|release\/|times-pipeline\/|[^/]+\/web\/)|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|\.github\/workflows\/(sync-runtime-config|release-desktop|release-mobile(-eink|-ios|-ota)?|maintenance-times[^/]*|maintenance-sync-rmrb)\.yml$)/,
  maintenance_scheduler: /^(tools\/maintenance-scheduler\/|infrastructure\/(cloudflare\/maintenance-scheduler\/|tencent-scf\/maintenance-scheduler\/|supabase\/migrations\/202609060001_maintenance_scheduler_state.sql)|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github\/workflows\/ci\.yml$)/,
  all_node: /^(\.github\/workflows\/ci\.yml$|tools\/ci\/|patches\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|\.npmrc$|\.pnpmfile\.cjs$)/,
  desktop_e2e: /^(frontend\/(desktop|web|packages\/(auth|content|pdf-viewer|ui)|tooling\/tsconfig|patches)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|\.github\/workflows\/(ci|release-desktop)\.yml$)/,
  web_e2e: /^(frontend\/(web|packages\/(auth|content|pdf-viewer|ui)|tooling\/tsconfig|patches)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|\.github\/workflows\/(ci|deploy-web)\.yml$)/,
  homepage_external: /^(content\/blog\/|\.github\/workflows\/deploy-homepage\.yml$)/,
  mobile_ios: /^(frontend\/mobile\/|frontend\/packages\/(auth|content|ui)\/|frontend\/tooling\/tsconfig\/|frontend\/patches\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|\.github\/workflows\/(ci|release-mobile-ios)\.yml$)/,
  cloud_api: /^(backend\/|tools\/times-pipeline\/|infrastructure\/edgeone\/|\.github\/workflows\/(ci|deploy-web|maintenance-times[^/]*)\.yml$)/,
  database: /^(infrastructure\/supabase\/|\.github\/workflows\/ci\.yml$)/,
  search_scf: /^(infrastructure\/tencent-scf\/search\/|\.github\/workflows\/(ci|release-search)\.yml$)/,
  times_pipeline: /^(tools\/(times-pipeline|ci|monitoring)\/|frontend\/packages\/content\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github\/workflows\/(ci|maintenance-times[^/]*|maintenance-sync-rmrb)\.yml$)/,
};

const consumers = {
  mobile_ios: "frontend/mobile",
  desktop_e2e: "frontend/desktop",
  web_e2e: "frontend/web",
};
const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies"];

// pnpm 9 stores peer/patch variants in snapshots and integrity in packages.
// Compare the entire reachable graph, including optional and workspace deps:
// comparing only importers misses transitive lockfile-only updates.
export function dependencyGraph(lock, importer) {
  if (String(lock?.lockfileVersion) !== "9.0" || !lock.importers || !lock.packages || !lock.snapshots) {
    throw new Error("Unsupported or incomplete pnpm lockfile");
  }
  const graph = new Map();
  const workspaces = new Set();
  const patches = new Set();
  function visitDependencies(entry, from) {
    for (const group of dependencyGroups) {
      for (const [name, dependency] of Object.entries(entry[group] ?? {})) {
        const reference = typeof dependency === "string" ? dependency : dependency.version;
        if (typeof reference !== "string") throw new Error(`Missing resolution for ${name}`);
        if (reference.startsWith("link:")) {
          visitWorkspace(posix.normalize(posix.join(from, reference.slice(5))));
        } else {
          const key = [`${name}@${reference}`, reference].find((candidate) => Object.hasOwn(lock.snapshots, candidate));
          if (!key) throw new Error(`Unrecognized dependency resolution: ${name}`);
          visitPackage(key);
        }
      }
    }
  }
  function visitWorkspace(directory) {
    const key = `workspace:${directory}`;
    if (graph.has(key)) return;
    const entry = lock.importers[directory];
    if (!entry) throw new Error(`Missing workspace importer: ${directory}`);
    graph.set(key, entry);
    workspaces.add(directory);
    visitDependencies(entry, directory);
  }
  function visitPackage(key) {
    if (graph.has(key)) return;
    const base = key.split("(")[0];
    const metadata = lock.packages[base];
    if (!metadata) throw new Error(`Missing package metadata: ${base}`);
    graph.set(key, { snapshot: lock.snapshots[key], metadata });
    const patch = lock.patchedDependencies?.[base];
    if (patch) {
      graph.set(`patch:${base}`, patch);
      patches.add(patch.path);
    }
    visitDependencies(lock.snapshots[key], ".");
  }
  visitWorkspace(importer);
  return { graph, workspaces, patches };
}

function globalPackageConfig(manifest) {
  const config = structuredClone(manifest);
  // These declarative rules are materialized in the frozen lockfile graph.
  // Scripts, engines, tooling and other pnpm settings still invalidate all.
  if (config.pnpm) {
    for (const key of ["overrides", "packageExtensions", "patchedDependencies"]) delete config.pnpm[key];
    if (Object.keys(config.pnpm).length === 0) delete config.pnpm;
  }
  return config;
}

function globalLockConfig(lock) {
  const config = { ...lock };
  for (const key of ["importers", "packages", "snapshots", "overrides", "patchedDependencies", "packageExtensionsChecksum"]) delete config[key];
  return config;
}

export function classify({ files, before, after, forceAll = false }) {
  const flags = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, files.some((file) => pattern.test(file))]));
  const globalChange = files.some((file) => /^(tools\/ci\/|\.github\/workflows\/ci\.yml$|pnpm-workspace\.yaml$|turbo\.json$|\.npmrc$|\.pnpmfile\.cjs$|patches\/)/.test(file));
  let fallback;
  try {
    if (forceAll || globalChange) throw new Error("Full verification requested or CI/toolchain configuration changed");
    if (!isDeepStrictEqual(globalPackageConfig(before.manifest), globalPackageConfig(after.manifest)) ||
        !isDeepStrictEqual(globalLockConfig(before.lock), globalLockConfig(after.lock)) ||
        !isDeepStrictEqual(dependencyGraph(before.lock, ".").graph, dependencyGraph(after.lock, ".").graph)) {
      throw new Error("Root tooling or installation settings changed");
    }
    for (const [flag, importer] of Object.entries(consumers)) {
      const previous = dependencyGraph(before.lock, importer);
      const current = dependencyGraph(after.lock, importer);
      const workspaces = new Set([...previous.workspaces, ...current.workspaces]);
      const patches = new Set([...previous.patches, ...current.patches]);
      const knownPatches = new Set([
        ...Object.values(before.lock.patchedDependencies ?? {}).map((patch) => patch.path),
        ...Object.values(after.lock.patchedDependencies ?? {}).map((patch) => patch.path),
      ]);
      flags[flag] = !isDeepStrictEqual(previous.graph, current.graph) || files.some((file) => {
        if (file === "package.json" || file === "pnpm-lock.yaml") return false;
        if (patches.has(file)) return true;
        if (knownPatches.has(file)) return false;
        // Keep workflow/shared-tooling path rules and add transitive workspace consumers.
        return patterns[flag].test(file) || [...workspaces].some((directory) => directory !== "." && file.startsWith(`${directory}/`));
      });
    }
  } catch (error) {
    // An unknown lockfile shape must never silently suppress a required build.
    fallback = error.message;
    flags.all_node = true;
    for (const flag of Object.keys(consumers)) flags[flag] = true;
  }
  if (forceAll) for (const flag of Object.keys(flags)) flags[flag] = true;
  return { flags, fallback };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function classifyGit(base, head, { forceAll = false } = {}) {
  const files = git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean);
  let before, after;
  try {
    const read = (ref) => ({
      manifest: JSON.parse(git("show", `${ref}:package.json`)),
      lock: parse(git("show", `${ref}:pnpm-lock.yaml`)),
    });
    before = read(base);
    after = read(head);
  } catch {
    // classify() will conservatively run all Node/consumer checks.
  }
  return { files, ...classify({ files, before, after, forceAll }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const head = process.env.EVENT_HEAD_SHA || git("rev-parse", "HEAD").trim();
  let base = process.env.EVENT_BASE_SHA;
  let forceAll = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (!base || /^0+$/.test(base)) {
    // New branches/manual runs have no reliable comparison; verify everything.
    base = head;
    forceAll = true;
  }
  const { files, flags, fallback } = classifyGit(base, head, { forceAll });
  console.log(JSON.stringify({ base, head, files, flags, fallback }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({ base_sha: base, head_sha: head, ...flags })
      .map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}
