import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const projectId = '1f56925df24b421da482cc21d3799aae';
const remoteDebuggingPort = '9333';

function assertClose(name, actual, expected, tolerance = 2) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
  }
}

function waitForLine(buffer, matcher, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (matcher(buffer.value)) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for output. Current output:\n${buffer.value}`));
      }
    }, 200);
  });
}

const output = { value: '' };
let browser;
const devRunner = spawn(process.execPath, ['./dev-runner.mjs', 'electron'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    JOJO_PRESS_REMOTE_DEBUGGING_PORT: remoteDebuggingPort
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

devRunner.stdout?.on('data', (chunk) => {
  const text = chunk.toString();
  output.value += text;
  process.stdout.write(text);
});

devRunner.stderr?.on('data', (chunk) => {
  const text = chunk.toString();
  output.value += text;
  process.stderr.write(text);
});

try {
  await waitForLine(output, (text) => text.includes('[dev-runner] Starting Electron...'), 60000);
  await delay(3000);

  const rendererUrlMatch = output.value.match(/\[dev-runner\] Detected Vite URL: (http:\/\/127\.0\.0\.1:\d+\/?)/);
  const enginePortMatch = output.value.match(/\[dev-runner\] Selected engine port (\d+)/);

  if (!rendererUrlMatch || !enginePortMatch) {
    throw new Error(`Could not determine renderer or engine port from output:\n${output.value}`);
  }

  const rendererUrl = rendererUrlMatch[1].replace(/\/$/, '');
  const apiBaseUrl = `http://127.0.0.1:${enginePortMatch[1]}`;
  const proofreadUrl = `${rendererUrl}/projects/${projectId}/proofread?apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(proofreadUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('img[alt="第 1 页预览"]', { timeout: 30000 });
  await page.waitForSelector('[aria-label="block-1 bbox"]', { timeout: 30000 });

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
  await page.screenshot({ path: 'proofread-electron-alignment.png' });
} finally {
  await browser?.close();
  devRunner.kill();
}
