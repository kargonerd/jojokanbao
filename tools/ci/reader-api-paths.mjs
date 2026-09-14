// Every Reader API path a production caller uses must be a route the backend
// actually serves.
//
// 202609140001_annotations_direct_rpc.sql removed /api/v1/annotations, but
// tools/beta-smoke/comments.mjs still composed that path through readerRequest()
// and kept returning 404 until #332 fixed it. The removed path never appeared as
// a literal, so grepping for the route that was deleted cannot see this class of
// break. Reading the route table out of the backend and comparing it with the
// call sites does see it, including paths assembled from a variable.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public callers reach the API as /api/v1/<path>; ASGIPathStripMiddleware turns
// that into /v1/<path>, and every router mounts at /v1. The mapping only holds
// while that stays true, so the mounts are asserted rather than assumed.
export const expectedMount = '/v1';

// Scanned last, deepest first, so the walk order stays deterministic.
const scannedRoots = ['backend', 'frontend', 'infrastructure', 'tools'];

// Generated, installed or deliberately historical trees: they either restate the
// API surface or describe someone else's.
const excludedDirectories = new Set([
  '.edgeone', '.expo', '.git', '.next', '.turbo', 'build', 'coverage', 'dist',
  'node_modules', 'Pods', 'vendor',
]);
const excludedPaths = [
  // Historical SQL is the record of what used to exist.
  'infrastructure/supabase/migrations',
  // Third-party feed endpoints only look like Reader API paths.
  'tools/times-pipeline/src/sources',
  // This check names removed paths by design, so it cannot police itself.
  'tools/ci/reader-api-paths.mjs',
];

// Test files use API paths as fixture keys, and prose describes them.
const excludedFile = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.md$/;

const scannedExtensions = new Set([
  '.cjs', '.js', '.json', '.jsx', '.mjs', '.py', '.sh', '.ts', '.tsx', '.yaml', '.yml',
]);

const maximumFileBytes = 1_048_576;

// Negative probes assert that a path is *not* served. They are the only accepted
// reason for a caller to name a route the backend does not declare.
export const deliberateNegativeProbes = [
  {
    path: '/times',
    file: 'infrastructure/edgeone/verify-python-bundle.py',
    reason: 'asserts JOJO Times is not exposed by the production Python bundle',
  },
  {
    path: '/annotations',
    file: 'infrastructure/edgeone/verify-python-bundle.py',
    reason: 'asserts the removed reader annotation proxy stays out of the Python bundle',
  },
];

const routeDeclaration = /@router\.(?:get|post|put|patch|delete)\(\s*"([^"]*)"/g;
const routerMount = /include_router\([^,]+,\s*prefix="([^"]+)"\)/g;
// A literal can sit in a template expression, so the quote is not required. The
// segment must be non-empty, which keeps the `${base}/api/v1/${path}` helper and
// prefix patterns from reading as a request.
const literalPath = /\/api\/v1\/[A-Za-z0-9_\-/]+/g;
// readerRequest(env, 'path') composes the URL from a variable, which is exactly
// how the removed proxy stayed reachable after its route was deleted.
const dynamicCallPath = /readerRequest\([^,()]+,\s*['"]([^'"]+)['"]/g;

export function normalizeApiPath(path) {
  let normalized = path.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

// Router paths are declared relative to their mount, so stripping /api/v1 is
// enough to compare them with a caller.
function referenceSuffix(raw) {
  return normalizeApiPath(raw.replace(/^\/api\/v1/, ''));
}

function routePattern(declared) {
  const normalized = normalizeApiPath(declared);
  const source = normalized
    .split(/(\{[^/}]+\})/)
    .map((part) => (/^\{[^/}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

function lineOf(text, index) {
  let line = 1;
  for (let cursor = text.indexOf('\n'); cursor !== -1 && cursor < index; cursor = text.indexOf('\n', cursor + 1)) {
    line += 1;
  }
  return line;
}

export function collectServedRoutes(files) {
  const mounts = new Set();
  const routes = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(routerMount)) mounts.add(match[1]);
    for (const match of text.matchAll(routeDeclaration)) {
      routes.push({ path: normalizeApiPath(match[1]), file, line: lineOf(text, match.index) });
    }
  }
  return { mounts, routes };
}

// Explaining a removal in a comment is documentation, not a request. Only
// references that a runtime would act on are compared against the route table.
function isCommentedOut(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index).trimStart();
  return prefix.startsWith('//') || prefix.startsWith('#') || prefix.startsWith('/*') || prefix.startsWith('*');
}

export function collectReferences(files) {
  const references = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(literalPath)) {
      if (isCommentedOut(text, match.index)) continue;
      references.push({
        file, line: lineOf(text, match.index), path: referenceSuffix(match[0]), kind: 'literal',
      });
    }
    for (const match of text.matchAll(dynamicCallPath)) {
      if (isCommentedOut(text, match.index)) continue;
      references.push({
        file, line: lineOf(text, match.index), path: referenceSuffix(match[1]), kind: 'readerRequest',
      });
    }
  }
  return references;
}

export function findStaleReferences({ served, references, allow = deliberateNegativeProbes }) {
  const patterns = served.routes.map((route) => routePattern(route.path));
  const consumed = new Set();
  const stale = [];
  for (const reference of references) {
    if (patterns.some((pattern) => pattern.test(reference.path))) continue;
    const allowance = allow.findIndex((entry) => entry.path === reference.path && entry.file === reference.file);
    if (allowance !== -1) {
      consumed.add(allowance);
      continue;
    }
    stale.push(reference);
  }
  // A probe that stopped naming the path no longer documents anything.
  const unusedAllow = allow.filter((_entry, index) => !consumed.has(index));
  return { stale, unusedAllow };
}

export function describeMismatches({ stale, unusedAllow }) {
  const lines = [];
  if (stale.length) {
    lines.push('Call sites use Reader API paths the backend does not serve:');
    for (const item of stale) {
      lines.push(`  ${item.file}:${item.line} names /api/v1${item.path} via ${item.kind}`);
    }
    lines.push('Serve the route again, move the caller onto a served route, or - if the reference');
    lines.push('deliberately asserts the path is gone - add it to deliberateNegativeProbes.');
  }
  if (unusedAllow.length) {
    lines.push('deliberateNegativeProbes entries no longer match any call site and must be removed:');
    for (const entry of unusedAllow) lines.push(`  ${entry.file} no longer names /api/v1${entry.path}`);
  }
  return lines.join('\n');
}

function walk(root, directory = '', files = []) {
  const absolute = join(root, directory);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relativePath = directory ? posix.join(directory, entry.name) : entry.name;
    if (excludedPaths.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) continue;
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      walk(root, relativePath, files);
      continue;
    }
    if (!entry.isFile() || excludedFile.test(relativePath)) continue;
    if (!scannedExtensions.has(posix.extname(entry.name))) continue;
    if (statSync(join(root, relativePath)).size > maximumFileBytes) continue;
    files.push({ file: relativePath, text: readFileSync(join(root, relativePath), 'utf8') });
  }
  return files;
}

export function readScannedFiles(repoRoot) {
  const files = [];
  for (const scanRoot of scannedRoots) walk(repoRoot, scanRoot, files);
  return files;
}

export function checkReaderApiPaths(repoRoot) {
  const files = readScannedFiles(repoRoot);
  const served = collectServedRoutes(files.filter(({ file }) => file.startsWith('backend/')));
  const unexpectedMounts = [...served.mounts].filter((mount) => mount !== expectedMount).sort();
  if (unexpectedMounts.length) {
    throw new Error(`Routers mount at ${unexpectedMounts.join(', ')}; this check maps /api/v1 onto ${expectedMount} only`);
  }
  const references = collectReferences(files);
  const result = findStaleReferences({ served, references });
  return { ...result, served, references, description: describeMismatches(result) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = checkReaderApiPaths(repoRoot);
  if (result.description) {
    console.error(result.description);
    process.exitCode = 1;
  } else {
    console.log(`Reader API paths match the backend: ${result.served.routes.length} routes, ${result.references.length} call sites`);
  }
}
