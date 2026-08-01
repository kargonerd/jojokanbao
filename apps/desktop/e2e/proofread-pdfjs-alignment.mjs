import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectId = '1f56925df24b421da482cc21d3799aae';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const engineDir = path.resolve(__dirname, '..', '..', '..', 'services', 'press-engine');

function assertClose(name, actual, expected, tolerance = 2) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
  }
}

function stripAnsi(text) {
  return text.replace(/\[[0-9;]*m/g, '');
}

async function startVite() {
  const child = spawn(process.execPath, ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5180'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';

  const detectUrl = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    const match = stripAnsi(text).match(/https?:\/\/127\.0\.0\.1:\d+\/?/);
    return match?.[0]?.replace(/\/$/, '') ?? null;
  };

  return await new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error(`Timed out waiting for Vite. Output:\n${output}`));
      }
    }, 60000);

    const onData = (chunk) => {
      const url = detectUrl(chunk);
      if (url && !resolved) {
        resolved = true;
        clearTimeout(timer);
        setTimeout(() => resolve({ child, url }), 3000);
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`Vite exited with code ${code}. Output:\n${output}`));
      }
    });
  });
}

async function chooseEnginePort(rendererUrl) {
  for (const port of [8765, 8766, 8767, 8768, 8769]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: rendererUrl } });
      if (response.ok) {
        return { port, child: null };
      }
    } catch {
      const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'uvicorn', 'jojo_press.app:app', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: engineDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout?.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
      child.stderr?.on('data', (chunk) => process.stderr.write(`[backend error] ${chunk}`));
      await delay(3000);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: rendererUrl } });
        if (response.ok) {
          return { port, child };
        }
      } catch {
        child.kill();
      }
    }
  }

  throw new Error('Could not start or find a compatible backend server');
}

async function main() {
  let vite;
  let backend;
  let browser;

  try {
    vite = await startVite();
    backend = await chooseEnginePort(vite.url);
    const apiBaseUrl = `http://127.0.0.1:${backend.port}`;
    const url = `${vite.url}/projects/${projectId}/proofread?apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('img[alt="第 1 页预览"]');
    await page.waitForSelector('[aria-label="block-1 bbox"]');

    const data = await page.evaluate(() => {
      const preview = document.querySelector('img[alt="第 1 页预览"]');
      const iframe = document.querySelector('iframe[title="第 1 页预览"]');
      const canvas = document.querySelector('.page-canvas');
      const block = document.querySelector('[aria-label="block-1 bbox"]');
      if (!(preview instanceof HTMLImageElement) || !(canvas instanceof HTMLElement) || !(block instanceof HTMLElement)) {
        throw new Error('required proofread elements missing');
      }
      const previewRect = preview.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      return {
        hasIframe: Boolean(iframe),
        previewSrcPrefix: preview.src.slice(0, 30),
        previewRect,
        canvasRect,
        blockRect,
        blockText: block.textContent?.trim(),
        blockStyle: {
          left: block.style.left,
          top: block.style.top,
          width: block.style.width,
          height: block.style.height
        }
      };
    });

    assertClose('preview width', data.previewRect.width, data.canvasRect.width - 4);
    assertClose('preview height', data.previewRect.height, data.canvasRect.height - 4);
    if (data.hasIframe) {
      throw new Error('unexpected iframe fallback rendered');
    }

    console.log(JSON.stringify(data, null, 2));
    await page.screenshot({ path: 'proofread-pdfjs-alignment.png' });
  } finally {
    await browser?.close();
    backend?.child?.kill();
    vite?.child?.kill();
  }
}

await main();
