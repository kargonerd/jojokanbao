import { parentPort } from 'node:worker_threads';
import { EngineApplication, type EngineCommand } from './application.js';
import { loadEngineConfig } from './config.js';
import type { JsonObject } from './model.js';

if (!parentPort) throw new Error('Desktop engine worker requires a parent port');
const port = parentPort;

const application = new EngineApplication(loadEngineConfig());

port.on('message', async (message: {
  id: number;
  command: EngineCommand | 'projects:source:path' | 'settings:mineru:configure';
  payload?: JsonObject;
}) => {
  try {
    const value = message.command === 'projects:source:path'
      ? await application.sourcePdfPath(String(message.payload?.projectId ?? ''))
      : message.command === 'settings:mineru:configure'
        ? application.configureMineru(String(message.payload?.token ?? ''))
        : await application.invoke(message.command, message.payload);
    port.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: {
        status: Number((error as { status?: number })?.status ?? 500),
        message: error instanceof Error ? error.message : 'engine request failed',
      },
    });
  }
});
