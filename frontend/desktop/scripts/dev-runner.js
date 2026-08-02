import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { config as loadEnv } from 'dotenv';

import { buildRendererApiBaseUrl, chooseEnginePort } from './dev-runner-utils.js';

const defaultEnginePort = 8765;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopCwd = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(__dirname, '..', '..', '..');
const engineDir = path.resolve(monorepoRoot, 'frontend', 'desktop', 'engine');
const envPath = path.resolve(engineDir, '.env');
const loadedEnv = loadEnv({ path: envPath, override: false, quiet: true });
if (!loadedEnv.error) {
  console.log('[dev-runner] Loaded env from:', envPath);
}

const children = [];

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
    windowsHide: false,
    ...options
  });

  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(143);
});

// 去除 ANSI 转义序列
function stripAnsi(str) {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRenderer(vite) {
  let rendererUrl = '';
  let viteOutput = '';

  vite.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    viteOutput += text;
    
    // 提取 Vite 启动的 URL - 匹配各种格式
    const matches = text.match(/https?:\/\/[^\s'"]+/);
    if (matches && !rendererUrl) {
      rendererUrl = stripAnsi(matches[0]).replace(/['"]/g, '');
      console.log(`[dev-runner] Detected Vite URL: ${rendererUrl}`);
    }
  });

  vite.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    
    // 也从 stderr 提取 URL
    const matches = text.match(/https?:\/\/[^\s'"]+/);
    if (matches && !rendererUrl) {
      rendererUrl = stripAnsi(matches[0]).replace(/['"]/g, '');
      console.log(`[dev-runner] Detected Vite URL from stderr: ${rendererUrl}`);
    }
  });

  // 最多等待 30 秒
  for (let i = 0; i < 120; i++) {
    if (rendererUrl) {
      // 等待几秒让服务完全启动
      await delay(3000);
      console.log(`[dev-runner] Vite should be ready at ${rendererUrl}`);
      return rendererUrl;
    }

    await delay(250);
  }
  
  throw new Error('Timeout waiting for Vite to start. Output was: ' + viteOutput);
}

async function readEngineCompatibilityStatus(port, desktopOrigin) {
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const [healthResponse, recognitionResponse] = await Promise.all([
      fetchWithTimeout(`${baseUrl}/health`, {
        headers: desktopOrigin ? { Origin: desktopOrigin } : undefined,
      }),
      fetchWithTimeout(`${baseUrl}/tasks/__compat__/recognition/status`, {
        headers: desktopOrigin ? { Origin: desktopOrigin } : undefined,
      }),
    ]);

    return {
      statusCode: healthResponse.status,
      allowOriginHeader: healthResponse.headers.get('access-control-allow-origin'),
      recognitionStatusCode: recognitionResponse.status,
    };
  } catch {
    return null;
  }
}

async function waitForBackend(port, desktopOrigin) {
  const baseUrl = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/health`, {
        headers: desktopOrigin ? { Origin: desktopOrigin } : undefined
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until uvicorn finishes startup.
    }

    await delay(500);
  }

  throw new Error(`Timeout waiting for backend on ${baseUrl}`);
}

async function chooseDesktopEnginePort(desktopOrigin) {
  const statuses = [];
  for (let offset = 0; offset < 3; offset += 1) {
    statuses.push(await readEngineCompatibilityStatus(defaultEnginePort + offset, desktopOrigin));
  }
  return chooseEnginePort(statuses, defaultEnginePort, desktopOrigin);
}

async function runElectron() {
  console.log('[dev-runner] Starting Vite dev server...');
  
  // 2. 启动 Vite 开发服务器
  const vite = spawnProcess(process.execPath, [
    './node_modules/vite/bin/vite.js',
    '--host', '127.0.0.1',
    '--port', '5180'
  ], {
    cwd: desktopCwd,
    env: process.env
  });

  vite.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev-runner] Vite exited with code ${code}`);
      process.exit(code);
    }
  });

  // 3. 等待 Vite 启动
  let rendererUrl;
  try {
    rendererUrl = await waitForRenderer(vite);
  } catch (error) {
    console.error('[dev-runner] Failed to start Vite:', error);
    stopAll();
    process.exit(1);
  }

  const enginePort = await chooseDesktopEnginePort(rendererUrl);
  const engineApiBaseUrl = buildRendererApiBaseUrl(rendererUrl, enginePort);
  const existingEngineStatus = await readEngineCompatibilityStatus(enginePort, rendererUrl);

  console.log(`[dev-runner] Selected engine port ${enginePort}`);
  if (!existingEngineStatus) {
    console.log('[dev-runner] Starting backend server...');
    const backendCwd = engineDir;
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const backend = spawnProcess(pythonCmd, [
      '-m', 'uvicorn', 'jojo_press.app:app',
      '--host', '127.0.0.1',
      '--port', String(enginePort)
    ], {
      cwd: backendCwd,
      env: process.env
    });

    backend.stdout?.on('data', (chunk) => {
      console.log('[backend]', chunk.toString());
    });

    backend.stderr?.on('data', (chunk) => {
      console.error('[backend error]', chunk.toString());
    });

    console.log('[dev-runner] Waiting for backend to start...');
    try {
      await waitForBackend(enginePort, rendererUrl);
    } catch (error) {
      console.error('[dev-runner] Failed to start backend:', error);
      stopAll();
      process.exit(1);
    }
  } else {
    console.log('[dev-runner] Reusing compatible backend server...');
  }

  // 4. 启动 Electron
  console.log('[dev-runner] Starting Electron...');

  const electron = spawnProcess(process.execPath, [
    './node_modules/electron/cli.js',
    './electron/main.js'
  ], {
    cwd: desktopCwd,
    env: {
      ...process.env,
      JOJO_PRESS_RENDERER_URL: rendererUrl,
      JOJO_PRESS_API_BASE_URL: engineApiBaseUrl
    }
  });

  // 捕获 Electron 输出
  electron.stdout?.on('data', (chunk) => {
    console.log('[electron]', chunk.toString());
  });

  electron.stderr?.on('data', (chunk) => {
    console.error('[electron error]', chunk.toString());
  });

  electron.on('exit', (code) => {
    console.log(`[dev-runner] Electron exited with code ${code}`);
    stopAll();
    process.exit(code ?? 0);
  });
}

await runElectron();
