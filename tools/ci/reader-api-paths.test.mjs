import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkReaderApiPaths, collectReferences, collectServedRoutes, describeMismatches,
  findStaleReferences, normalizeApiPath,
} from './reader-api-paths.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Mirrors the real routers: relative paths, one trailing-slash alias, one path param.
const backend = [{
  file: 'backend/src/app/application.py',
  text: 'app.include_router(account_router, prefix="/v1")\napp.include_router(speech_router, prefix="/v1")\n',
}, {
  file: 'backend/src/app/account/router.py',
  text: '@router.get("/health", response_model=HealthResponse)\n@router.get("/me", response_model=CurrentUser)\n',
}, {
  file: 'backend/src/app/speech/router.py',
  text: '@router.get("/speech/providers")\n@router.post("/speech")\n@router.get("/speech/stream/")\n',
}, {
  file: 'backend/src/app/account/admin.py',
  text: '@router.post("/admin/moderation/comments/{comment_id}")\n',
}];

test('normalizeApiPath drops trailing slashes and requires a leading slash', () => {
  assert.equal(normalizeApiPath('/speech/stream/'), '/speech/stream');
  assert.equal(normalizeApiPath('annotations'), '/annotations');
  assert.equal(normalizeApiPath('/health/'), '/health');
});

test('collectServedRoutes reads mounts and declarations, keeping path params', () => {
  const { mounts, routes } = collectServedRoutes(backend);
  assert.deepEqual([...mounts].sort(), ['/v1']);
  assert.deepEqual(routes.map(({ path }) => path).sort(), [
    '/admin/moderation/comments/{comment_id}', '/health', '/me',
    '/speech', '/speech/providers', '/speech/stream',
  ]);
});

test('collectReferences sees literals however they are embedded', () => {
  const references = collectReferences([{
    file: 'frontend/web/src/api/agentGateway.ts',
    text: [
      'export type AgentGatewayPath = "/api/v1/speech" | "/api/v1/speech/providers";',
      'const url = `${base}/api/v1/account/signup-authorization`;',
      'const proxied = config.apiUrl("/api/v1/speech");',
    ].join('\n'),
  }]);
  assert.deepEqual(references.map(({ path }) => path), [
    '/speech', '/speech/providers', '/account/signup-authorization', '/speech',
  ]);
  assert.deepEqual([...new Set(references.map(({ kind }) => kind))], ['literal']);
});

test('collectReferences reads the path a readerRequest caller composes', () => {
  const references = collectReferences([{
    file: 'tools/beta-smoke/lib.mjs',
    text: "const result = await readerRequest(env, 'account/signup-authorization', { email, invitationCode });\n",
  }]);
  assert.deepEqual(references, [{
    file: 'tools/beta-smoke/lib.mjs', line: 1, path: '/account/signup-authorization', kind: 'readerRequest',
  }]);
});

test('paths named only in comments are documentation, not call sites', () => {
  const references = collectReferences([{
    file: 'tools/beta-smoke/comments.mjs',
    text: [
      'async function rpc(user, name) {',
      '  // the old /api/v1/annotations proxy is gone, so call the rpc directly',
      '  # a hash comment naming /api/v1/annotations as well',
      '  /* /api/v1/annotations */',
      '  return request(env, `rest/v1/rpc/${name}`);',
      '}',
    ].join('\n'),
  }]);
  assert.deepEqual(references, []);
});

test('the readerRequest helper template is not a call site', () => {
  const references = collectReferences([{
    file: 'tools/beta-smoke/lib.mjs',
    text: "const response = await fetch(`${base.replace(/\\/$/, '')}/api/v1/${path}`, {\n",
  }]);
  assert.deepEqual(references, []);
});

test('served routes are matched exactly, so a prefix does not cover its children', () => {
  const served = collectServedRoutes(backend);
  const references = collectReferences([{
    file: 'frontend/web/src/api/agentGateway.ts',
    text: 'const removed = "/api/v1/speech/voices";\n',
  }]);
  const { stale } = findStaleReferences({ served, references });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].path, '/speech/voices');
});

test('a path param route accepts a concrete id', () => {
  const served = collectServedRoutes(backend);
  const references = collectReferences([{
    file: 'tools/reader-admin/import.mjs',
    text: 'await post("/api/v1/admin/moderation/comments/8f2c");\n',
  }]);
  assert.deepEqual(findStaleReferences({ served, references }).stale, []);
});

// The break this check exists for: #331 removed /api/v1/annotations while
// comments.mjs still composed that path, and nothing else noticed for a day.
test('the removed annotations proxy call site is reported', () => {
  const served = collectServedRoutes(backend);
  const references = collectReferences([{
    file: 'tools/beta-smoke/comments.mjs',
    text: [
      "async function rpc(user, name, body = {}) {",
      "  const annotations = ['get_annotation_threads', 'create_content_annotation'];",
      "  const result = annotations.includes(name)",
      "    ? await readerRequest(env, 'annotations', { operation: name, params: body }, user?.token)",
      "    : await request(env, `rest/v1/rpc/${name}`, { token: user?.token, body });",
      "  return result;",
      "}",
    ].join('\n'),
  }]);
  const { stale, unusedAllow } = findStaleReferences({ served, references });
  // An allowance is keyed by file, so the negative probe that names the same path
  // in another file cannot excuse this caller.
  assert.deepEqual(unusedAllow.map(({ path }) => path), ['/times', '/annotations']);
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0], {
    file: 'tools/beta-smoke/comments.mjs', line: 4, path: '/annotations', kind: 'readerRequest',
  });
  assert.match(describeMismatches({ stale, unusedAllow }), /tools\/beta-smoke\/comments\.mjs:4 names \/api\/v1\/annotations/);
});

test('literals are reported too, so a hardcoded removed route cannot pass', () => {
  const served = collectServedRoutes(backend);
  const references = collectReferences([{
    file: 'tools/example/smoke.mjs', text: "await fetch(`${base}/api/v1/annotations`, { method: 'POST' });\n",
  }]);
  const { stale } = findStaleReferences({ served, references });
  assert.deepEqual(stale.map(({ path, kind }) => [path, kind]), [['/annotations', 'literal']]);
});

test('deliberate negative probes are allowed, and stop being allowed once stale', () => {
  const served = collectServedRoutes(backend);
  const probe = [{
    file: 'infrastructure/edgeone/verify-python-bundle.py',
    text: 'response = await client.post("/api/v1/annotations", json={"operation": "get_annotation_threads"})\n',
  }];
  assert.deepEqual(findStaleReferences({ served, references: collectReferences(probe) }).stale, []);

  const removed = [{ file: 'infrastructure/edgeone/verify-python-bundle.py', text: 'response = None\n' }];
  const { unusedAllow } = findStaleReferences({ served, references: collectReferences(removed) });
  assert.deepEqual(unusedAllow.map(({ path }) => path), ['/times', '/annotations']);
});

test('the repository matches its own backend routes', () => {
  const result = checkReaderApiPaths(repoRoot);
  assert.equal(result.description, '', result.description);
  assert.ok(result.served.routes.length >= 8, 'expected the account, signup, admin and speech routes');
  assert.ok(result.references.length >= 8, 'expected the reader call sites to be scanned');
});

test('the repository declares the routes the clients depend on', () => {
  const { routes } = checkReaderApiPaths(repoRoot).served;
  const declared = new Set(routes.map(({ path }) => path));
  for (const path of ['/health', '/account/signup-authorization', '/speech', '/speech/providers', '/speech/stream']) {
    assert.ok(declared.has(path), `expected ${path} to be served`);
  }
  assert.ok(!declared.has('/annotations'), 'the annotation proxy route must stay removed');
});
