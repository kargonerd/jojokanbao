// Local administration; secrets travel via private tccli request files, not argv.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scf } from '../maintenance-scheduler/ops.mjs';
import { SLUG, SCHEDULE, TRIGGER, PERIODS, LEVELS } from '../../../tools/email-quota/monitor.mjs';
export const FUNCTION = 'jojokanbao-email-quota';
const here = fileURLToPath(new URL('.', import.meta.url));
const call = (action, data = {}) => scf(action, { ...data, FunctionName: FUNCTION });
const key = () => process.env.HEALTHCHECKS_API_KEY ?? process.env.HEALTHCHECK_API_KEY;
async function active() {
  for (let count = 0; count < 15; count++) {
    const info = await call('GetFunction');
    if (info.Status === 'Active') return info;
    if (['Failed', 'Error'].includes(info.Status)) throw new Error('Quota function activation failed');
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error('Quota function activation timed out');
}
async function healthchecks(method, path = '', body) {
  const response = await fetch(`https://healthchecks.io/api/v3/checks/${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'X-Api-Key': key(), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Healthchecks configuration HTTP ${response.status}`);
  return response.json();
}
export async function provision() {
  const current = await healthchecks('GET');
  const channels = current.checks?.find((check) => check.slug === 'jojo-email-delivery')?.channels;
  if (!channels) throw new Error('Existing email alert channels are missing');
  const definitions = [{ slug: SLUG, name: 'JOJO · 邮件额度检查', schedule: SCHEDULE, tz: 'UTC', grace: 600,
    desc: '独立 SCF 每 30 分钟读取 Resend 用量。当前使用邮件记录估算；采集失败或未按时运行时报警。' },
  ...PERIODS.flatMap((period) => LEVELS.map((level) => ({
    slug: `${SLUG}-${period}-${level}`,
    name: `JOJO · ${period === 'daily' ? '日' : '月'}邮件额度${{ warning: '预警', critical: '紧急', exhausted: '100%阈值' }[level]}`,
    // These checks represent conditions, not the collector's heartbeat. Only
    // the separate half-hour check reports a missed invocation.
    timeout: 31_536_000, grace: 3600,
    desc: '默认 80%/90%/100% 阈值。当前日用量按记录估算，月用量按最近31天记录加两天日额度保守估算，可能提前提醒；估算达到100%不代表实际耗尽。状态转换去重。详情见最近事件。',
  })))];
  for (const definition of definitions) await healthchecks('POST', '', { ...definition, methods: 'POST', channels, tags: 'jojo production email quota', unique: ['slug'] });
  console.log(JSON.stringify({ checksConfigured: definitions.map(({ slug }) => slug), channelsReused: true }));
}
export async function main(action) {
  if (action === 'provision') return provision();
  if (action === 'create') {
    const variables = { RESEND_QUOTA_API_KEY: process.env.RESEND_QUOTA_API_KEY, HEALTHCHECKS_API_KEY: key(),
      SUPABASE_URL: process.env.VITE_SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY };
    for (const [name, value] of Object.entries(variables)) if (!value) throw new Error(`Missing ${name}`);
    await call('CreateFunction', { Runtime: 'Nodejs20.19', Type: 'Event', Handler: 'index.main_handler',
      Description: 'JOJO Resend quota alerts, direct read-only HTTP every 30 minutes',
      Code: { ZipFile: (await readFile(`${here}/dist/function.zip`)).toString('base64') }, MemorySize: 128, Timeout: 55,
      Environment: { Variables: Object.entries(variables).map(([Key, Value]) => ({ Key, Value })) },
      PublicNetConfig: { PublicNetStatus: 'ENABLE', EipConfig: { EipStatus: 'DISABLE' } }, AutoCreateClsTopic: 'TRUE', AutoDeployClsTopicIndex: 'TRUE' });
    await active();
    await call('PutReservedConcurrencyConfig', { ReservedConcurrencyMem: 128 });
    console.log(JSON.stringify({ created: FUNCTION, timerEnabled: false, maxConcurrency: 1 }));
  } else if (action === 'deploy') {
    const existing = await call('GetFunction');
    if (existing.Runtime !== 'Nodejs20.19' || existing.Type !== 'Event') throw new Error('Unexpected quota function');
    await call('UpdateFunctionCode', { ZipFile: (await readFile(`${here}/dist/function.zip`)).toString('base64'), Handler: 'index.main_handler', CodeSource: 'ZipFile' });
    await active();
    console.log('Quota code deployed; credentials and timer preserved.');
  } else if (action === 'probe' || action === 'check') {
    const result = await call('Invoke', { InvocationType: 'RequestResponse', ClientContext: JSON.stringify({ mode: action }), LogType: 'None' });
    let value; try { value = JSON.parse(result.Result?.RetMsg); } catch { throw new Error('Invalid quota invoke result'); }
    if (result.Result?.FunctionError || value?.ok !== true) throw new Error(`Quota ${action} failed: ${/^[a-z0-9_]+$/.test(value?.error ?? '') ? value.error : 'function_error'}`);
    console.log(JSON.stringify(value));
  } else if (action === 'timer') {
    const existing = await call('ListTriggers');
    if (existing.Triggers?.length) {
      if (existing.Triggers.length !== 1 || existing.Triggers[0].TriggerName !== 'email-quota-half-hour' || existing.Triggers[0].TriggerDesc !== TRIGGER) throw new Error('Unexpected quota timer');
      console.log('Half-hour timer already configured.'); return;
    }
    await call('CreateTrigger', { TriggerName: 'email-quota-half-hour', Type: 'timer', TriggerDesc: TRIGGER, Enable: 'OPEN' });
    console.log('Native half-hour timer enabled.');
  } else if (action === 'status') {
    const info = await call('GetFunction');
    const triggers = await call('ListTriggers');
    const all = await healthchecks('GET');
    console.log(JSON.stringify({ function: FUNCTION, status: info.Status, runtime: info.Runtime, memory: info.MemorySize, timeout: info.Timeout,
      triggers: triggers.Triggers?.map(({ TriggerName, TriggerDesc, Enable }) => ({ TriggerName, TriggerDesc, Enable })),
      checks: all.checks.filter((check) => check.slug.startsWith(SLUG)).map(({ name, slug, status, last_ping, channels }) => ({ name, slug, status, last_ping, channels })) }));
  } else if (action === 'logs') {
    const result = await call('GetFunctionLogs', { Limit: 10 });
    console.log(JSON.stringify(result.Data?.map(({ StartTime, RequestId, RetCode, RetMsg }) => ({ StartTime, RequestId, RetCode, RetMsg }))));
  } else throw new Error('Usage: ops.mjs provision|create|deploy|probe|check|timer|status|logs');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
