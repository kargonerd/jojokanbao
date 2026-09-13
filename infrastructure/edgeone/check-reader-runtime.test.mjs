import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReaderRuntime } from './check-reader-runtime.mjs';

const env = { VITE_SUPABASE_URL: 'https://db.example', VITE_SUPABASE_PUBLISHABLE_KEY: 'public' };
test('publishes only after the required database contract is installed', async () => {
  assert.equal(await checkReaderRuntime(env, async () => Response.json('202609130004')), true);
  assert.equal(await checkReaderRuntime(env, async () => Response.json({ code: 'PGRST202' }, { status: 404 })), false);
  await assert.rejects(checkReaderRuntime(env, async () => Response.json('unexpected')));
  await assert.rejects(checkReaderRuntime(env, async () => Response.json({ message: 'unavailable' }, { status: 503 })));
});
