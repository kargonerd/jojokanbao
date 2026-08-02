import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { config as loadEnv } from 'dotenv';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDir, '..');
loadEnv({ path: path.join(desktopRoot, '.env'), override: false, quiet: true });

const compile = spawnSync(
  process.execPath,
  [
    path.join(desktopRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    path.join(desktopRoot, 'tsconfig.engine.json'),
  ],
  { cwd: desktopRoot, stdio: 'inherit', shell: false },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

const children = [];
const spawnChild = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: desktopRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  children.push(child);
  return child;
};
const stopAll = () => children.forEach((child) => {
  if (!child.killed) child.kill();
});
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(143);
});

const vite = spawnChild(process.execPath, [
  path.join(desktopRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host',
  '127.0.0.1',
  '--port',
  '5180',
  '--strictPort',
]);

const rendererUrl = 'http://127.0.0.1:5180';
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    if ((await fetch(rendererUrl)).ok) break;
  } catch {
    if (attempt === 59) {
      stopAll();
      throw new Error(`Vite did not start at ${rendererUrl}`);
    }
  }
  await delay(250);
}

const electron = spawnChild(process.execPath, [
  path.join(desktopRoot, 'node_modules', 'electron', 'cli.js'),
  path.join(desktopRoot, 'electron', 'main.js'),
], {
  env: { ...process.env, JOJO_DESKTOP_RENDERER_URL: rendererUrl },
});
electron.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 0);
});
