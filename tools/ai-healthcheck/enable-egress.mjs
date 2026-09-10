// Local administration only; no management key is added to the monitor workflow.
import { loadEnvironment, literal, query } from '../beta-smoke/lib.mjs';

const accountId = process.argv[2];
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(accountId ?? '')) {
  throw new Error('Pass the verified existing AI monitor user ID');
}
const env = loadEnvironment(process.cwd());
if (env.SUPABASE_PROJECT_REF !== 'hrueccyqzfzduzfmqcia'
  || env.VITE_SUPABASE_URL?.replace(/\/$/, '') !== `https://${env.SUPABASE_PROJECT_REF}.supabase.co`) {
  throw new Error('Unexpected project; this command targets the JOJO Auth project only');
}
// The operator explicitly selects one account. Never promote every account with
// user-editable monitor metadata, and preserve all other application metadata.
const updated = await query(env, `
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || '{"account_purpose":"ai_availability_monitor"}'::jsonb
  where id = ${literal(accountId)}::uuid
    and role = 'authenticated' and email_confirmed_at is not null
    and raw_user_meta_data->>'account_purpose' = 'ai_availability_monitor'
    and (raw_app_meta_data->>'account_purpose' is null
      or raw_app_meta_data->>'account_purpose' = 'ai_availability_monitor')
  returning id
`, false);
if (updated.length !== 1) throw new Error('Expected one confirmed AI monitor account; no account was changed');
console.log(JSON.stringify({ accountId: updated[0].id, egressDiagnosticsEnabled: true }));
