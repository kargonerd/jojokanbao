import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function checkReaderRuntime(env, request = fetch) {
  const base = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) throw new Error('Supabase deployment configuration is missing');
  const response = await request(`${base.replace(/\/$/, '')}/rest/v1/rpc/get_reader_runtime_contract`, {
    headers: { apikey: key }, signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (response.ok && payload === '202609130005') return true;
  if (response.status === 404 && payload?.code === 'PGRST202') return false;
  throw new Error(`Reader database contract check failed (HTTP ${response.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ready = await checkReaderRuntime(process.env);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
  if (!ready) {
    if (process.env.EDGEONE_DEPLOY_ENV === 'production') throw new Error('Apply the reader runtime migration and configure API/Agent runtime secrets before releasing');
    console.log('::notice::Beta publication deferred: the reader runtime database migration is not installed. Configure API/Agent runtime secrets, apply the migration in the coordinated release window, then rerun Deploy Web.');
  }
}
