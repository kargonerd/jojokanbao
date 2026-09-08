// Local administration only. The management token never enters GitHub or SCF.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadEnvironment, literal, query, management, getAdminKey } from '../beta-smoke/lib.mjs';

const env = loadEnvironment(process.argv[2] ?? process.cwd());
const purpose = 'email_delivery_monitor';
if (env.SUPABASE_PROJECT_REF !== 'hrueccyqzfzduzfmqcia'
  || env.VITE_SUPABASE_URL?.replace(/\/$/, '') !== `https://${env.SUPABASE_PROJECT_REF}.supabase.co`) {
  throw new Error('Unexpected project; this provisioner targets the JOJO Auth project only');
}
function github(kind, name, value) {
  const binary = process.platform === 'win32' ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh';
  const args = [kind, 'set', name, '--repo', 'kargonerd/jojokanbao'];
  const output = spawnSync(binary, args, { input: value, encoding: 'utf8', windowsHide: true });
  if (output.status !== 0) throw new Error(`GitHub ${kind} setup failed: ${name}`);
}

const auth = await management(env, 'config/auth');
if (auth.smtp_host !== 'smtp.resend.com' || !auth.smtp_admin_email) throw new Error('Resend SMTP is not configured');
const accounts = await query(env, `select id, email from auth.users where raw_app_meta_data->>'account_purpose' = ${literal(purpose)}`);
if (accounts.length > 1) throw new Error('Multiple mail monitor accounts; inspect before changing anything');
let account = accounts[0];
if (!account) {
  const email = `delivered+jojo-monitor-${randomBytes(12).toString('hex')}@resend.dev`;
  const [invitation] = await query(env, `select * from private.create_signup_invitation(null, interval '1 hour', 1, 'Email delivery monitor provisioning')`, false);
  const key = await getAdminKey(env);
  const response = await fetch(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/auth/v1/admin/users`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
    email, password: randomBytes(32).toString('base64url'), email_confirm: true,
    user_metadata: { invitation_code: invitation.code, account_purpose: purpose },
    app_metadata: { account_purpose: purpose },
  }) });
  if (!response.ok) throw new Error(`Mail monitor account creation HTTP ${response.status}`);
  const created = await response.json();
  if (!created.id) throw new Error('Mail monitor account creation response invalid');
  account = { id: created.id, email };
}
if (!/^delivered\+jojo-monitor-[a-f0-9]{24}@resend\.dev$/.test(account.email)) throw new Error('Unexpected mail monitor address; no credentials changed');

const response = await fetch('https://healthchecks.io/api/v3/checks/', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
  headers: { 'X-Api-Key': env.HEALTHCHECKS_API_KEY ?? env.HEALTHCHECK_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'JOJO · Email delivery', slug: 'jojo-email-delivery', schedule: '8,23,38,53 * * * *',
    tz: 'UTC', grace: 1200, tags: 'jojo production email', methods: 'POST', channels: '*', unique: ['slug'],
    desc: 'Resend delivery observations every 15 minutes, with one Supabase SMTP verification to a Resend test address every 4 hours. Only the SCF consumer reports health transitions.' }),
});
if (!response.ok) throw new Error(`Mail monitor Healthchecks configuration HTTP ${response.status}`);
const check = await response.json();
if (!/^https:\/\/hc-ping\.com\/[a-f0-9-]{36}$/.test(check.ping_url ?? '')) throw new Error('Mail monitor check identity missing');
github('secret', 'JOJO_EMAIL_MONITOR_ADDRESS', account.email);
github('secret', 'JOJO_EMAIL_HEALTHCHECK_PING_URL', check.ping_url);
github('variable', 'JOJO_EMAIL_SENDER', auth.smtp_admin_email);
console.log(JSON.stringify({ accountId: account.id, accountPurpose: purpose, healthcheckConfigured: true,
  setup: ['JOJO_EMAIL_MONITOR_ADDRESS', 'JOJO_EMAIL_HEALTHCHECK_PING_URL', 'JOJO_EMAIL_SENDER'],
  message: 'RESEND_MONITOR_API_KEY is managed separately; no email sent by provisioning.' }));
