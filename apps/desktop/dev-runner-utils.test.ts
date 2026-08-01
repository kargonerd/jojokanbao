// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildWindowsKillCommand,
  buildRendererApiBaseUrl,
  chooseEnginePort,
  extractRendererUrl,
  shouldReuseRunningEngine,
  shouldReuseRunningEngineForDesktop
} from './dev-runner-utils.mjs';

describe('extractRendererUrl', () => {
  it('returns the actual Vite local url when the default port is unavailable', () => {
    const viteOutput = `Port 4173 is in use, trying another one...\nPort 4174 is in use, trying another one...\n\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m4179\u001b[22m/\u001b[39m`;

    expect(extractRendererUrl(viteOutput)).toBe('http://127.0.0.1:4179');
  });

  it('returns null before Vite prints a local url', () => {
    expect(extractRendererUrl('Port 4173 is in use, trying another one...')).toBeNull();
  });
});

describe('shouldReuseRunningEngine', () => {
  it('reuses the engine when the local health endpoint is already available', () => {
    expect(shouldReuseRunningEngine(200)).toBe(true);
  });

  it('starts a new engine when no healthy local engine is listening yet', () => {
    expect(shouldReuseRunningEngine(null)).toBe(false);
  });
});

describe('shouldReuseRunningEngineForDesktop', () => {
  it('reuses a healthy engine only when it allows the desktop origin and serves the recognition status route', () => {
    expect(shouldReuseRunningEngineForDesktop(200, 'http://127.0.0.1:4173', 'http://127.0.0.1:4173', 200)).toBe(true);
  });

  it('does not reuse a healthy engine that omits the desktop origin CORS header', () => {
    expect(shouldReuseRunningEngineForDesktop(200, null, 'http://127.0.0.1:4173')).toBe(false);
  });

  it('does not reuse a healthy engine that is missing the recognition status route', () => {
    expect(shouldReuseRunningEngineForDesktop(200, 'http://127.0.0.1:4173', 'http://127.0.0.1:4173', 404)).toBe(false);
  });
});

describe('buildWindowsKillCommand', () => {
  it('kills the full child process tree for a Windows process id', () => {
    expect(buildWindowsKillCommand(12345)).toBe('taskkill /PID 12345 /T /F');
  });
});

describe('buildRendererApiBaseUrl', () => {
  it('switches the renderer to the same host with the selected engine port', () => {
    expect(buildRendererApiBaseUrl('http://127.0.0.1:4182', 8766)).toBe('http://127.0.0.1:8766');
  });
});

describe('chooseEnginePort', () => {
  it('keeps the default engine port when nothing is already listening', () => {
    expect(chooseEnginePort([null])).toBe(8765);
  });

  it('reuses the first healthy engine port already in use', () => {
    expect(chooseEnginePort([200, null])).toBe(8765);
  });

  it('moves to the next port when the default engine port is occupied by another service', () => {
    expect(chooseEnginePort([404])).toBe(8766);
  });

  it('prefers the first free port when a healthy engine does not allow the desktop origin', () => {
    expect(
      chooseEnginePort(
        [
          { statusCode: 200, allowOriginHeader: null },
          { statusCode: null, allowOriginHeader: null }
        ],
        8765,
        'http://127.0.0.1:4173'
      )
    ).toBe(8766);
  });
});

describe('package scripts', () => {
  it('prepends the npm node directory to PATH before starting desktop runners', () => {
    const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.electron).toBe('set PATH=%npm_node_execpath:node.exe=%;%PATH% && node ./dev-runner.mjs electron');
    expect(packageJson.scripts['electron:dev']).toBe('set PATH=%npm_node_execpath:node.exe=%;%PATH% && node ./dev-runner.mjs electron');
    expect(packageJson.scripts['app:dev']).toBe('set PATH=%npm_node_execpath:node.exe=%;%PATH% && node ./dev-runner.mjs app');
  });

  it('selects an engine port dynamically instead of assuming 8765 is always safe to reuse', () => {
    const runnerSource = readFileSync(new URL('./dev-runner.mjs', import.meta.url), 'utf8');

    expect(runnerSource).toContain('chooseEnginePort(');
  });

  it('does not run the desktop backend with uvicorn reload enabled', () => {
    const runnerSource = readFileSync(new URL('./dev-runner.mjs', import.meta.url), 'utf8');

    expect(runnerSource).not.toContain("'--reload'");
  });

  it('uses dotenv instead of a hand-written parser for the engine env file', () => {
    const runnerSource = readFileSync(new URL('./dev-runner.mjs', import.meta.url), 'utf8');

    expect(runnerSource).toContain("import { config as loadEnv } from 'dotenv';");
    expect(runnerSource).toContain('loadEnv({ path: envPath, override: false, quiet: true })');
    expect(runnerSource).not.toContain("envContent.split('\\n')");
  });

  it('passes the selected engine api base url into Electron preload for renderer requests', () => {
    const runnerSource = readFileSync(new URL('./dev-runner.mjs', import.meta.url), 'utf8');

    expect(runnerSource).toContain('buildRendererApiBaseUrl(');
    expect(runnerSource).toContain('JOJO_PRESS_API_BASE_URL: engineApiBaseUrl');
  });

  it('reuses a compatible running backend instead of blindly spawning another process on the same port', () => {
    const runnerSource = readFileSync(new URL('./dev-runner.mjs', import.meta.url), 'utf8');

    expect(runnerSource).toContain('if (!existingEngineStatus)');
  });

});
