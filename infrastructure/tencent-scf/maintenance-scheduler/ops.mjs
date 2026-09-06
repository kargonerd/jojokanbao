// Deployment/control helper. Credentials come from --env-file or the shell.
// tccli payloads use a private temporary file, never secret-bearing argv/output.
import { readFile, writeFile, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const functionName = "jojokanbao-maintenance-scheduler";
export const region = "ap-singapore";
const here = fileURLToPath(new URL(".", import.meta.url));

export async function scf(action, parameters = {}) {
  const dir = await mkdtemp(join(tmpdir(), "jojo-scheduler-scf-"));
  const payload = join(dir, "request.json");
  try {
    await writeFile(payload, JSON.stringify({ Namespace: "default", FunctionName: functionName, ...parameters }), { mode: 0o600 });
    let output;
    try { output = execFileSync("tccli", ["scf", action, "--region", region, "--cli-input-json", `file://${payload}`],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 4*1024*1024, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      // CLI error output can contain payload fragments. Report only an error code.
      let detail = String(error.stderr || error.stdout || "");
      for (const value of [...Object.values(process.env), ...(parameters.Environment?.Variables?.map((v) => v.Value) ?? [])]) {
        if (value && value.length >= 16) detail = detail.replaceAll(value, "[redacted]");
      }
      const code = detail.match(/(?:Code|code)["':\s=]+([A-Za-z.]+)/)?.[1];
      const message = detail.match(/message[:\s]+(.+?)(?:requestId|\r?\n|$)/i)?.[1]?.slice(0,250);
      throw new Error(`SCF ${action} failed${code ? `: ${code}` : ""}${message ? ` (${message})` : ""}`);
    }
    const result = JSON.parse(output);
    if (result.Error) throw new Error(`SCF ${action}: ${result.Error.Code}`);
    return result;
  } finally { await rm(payload, { force: true }); await rmdir(dir); }
}

export async function waitActive() {
  for (let attempt=0; attempt<12; attempt++) {
    const info = await scf("GetFunction");
    if (info.Status === "Active") return info;
    if (["Failed", "Error"].includes(info.Status)) throw new Error(`SCF state: ${info.Status}`);
    await new Promise((done) => setTimeout(done, 3000));
  }
  throw new Error("SCF activation timed out");
}

export async function sql(query, parameters = [], readOnly = true) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) throw new Error("Supabase operator credentials missing");
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, parameters, read_only: readOnly }),
  });
  if (!response.ok) throw new Error(`Supabase admin query: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error("Supabase admin query failed");
  return body.result ?? body;
}

function environment(stateToken, mode) {
  const values = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HEALTHCHECKS_API_KEY: process.env.HEALTHCHECKS_API_KEY ?? process.env.HEALTHCHECK_API_KEY,
    GITHUB_OWNER: "kargonerd", GITHUB_REPO: "jojokanbao", GITHUB_REF: "master",
    SUPABASE_URL: process.env.VITE_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    SCHEDULER_STATE_TOKEN: stateToken, SCHEDULER_MODE: mode,
  };
  for (const [name, value] of Object.entries(values)) if (!value) throw new Error(`Missing ${name}`);
  return { Variables: Object.entries(values).map(([Key, Value]) => ({ Key, Value })) };
}

export function verifiedProbe(result) {
  const value = JSON.parse(result.Result?.RetMsg ?? "null");
  if (result.Result?.FunctionError || value?.errorCode || !Array.isArray(value?.connectivity)
    || value.connectivity.length !== 2 || value.connectivity.some((check) => check.ok !== true)
    || !["cloudflare", "tencent", "paused"].includes(value?.state?.backend)) {
    // SCF can return HTTP success with a function exception inside RetMsg.
    throw new Error(`Read-only probe failed${value?.stackTrace ? `: ${String(value.stackTrace).split("\n")[0]}` : ""}`);
  }
  return value;
}

async function main(action) {
  if (action === "status") {
    const info = await scf("GetFunction");
    console.log(JSON.stringify({ function: functionName, region, runtime: info.Runtime, status: info.Status,
      memory: info.MemorySize, timeout: info.Timeout, mode: info.Environment?.Variables?.find((v) => v.Key === "SCHEDULER_MODE")?.Value,
      modifiedAt: info.ModTime }));
    console.log(JSON.stringify(await scf("ListTriggers")));
  } else if (action === "create-shadow") {
    // Never silently update an existing function or rotate its state credential.
    const { stdout } = { stdout: execFileSync("tccli", ["scf", "ListFunctions", "--region", region, "--Limit", "100"], { encoding: "utf8", timeout: 30_000 }) };
    if (JSON.parse(stdout).Functions?.some((f) => f.FunctionName === functionName)) throw new Error("Function already exists; use deploy");
    const stateToken = randomBytes(32).toString("hex");
    const code = await readFile(`${here}/dist/function.zip`);
    await scf("CreateFunction", { Runtime: "Nodejs20.19", Type: "Event", Handler: "index.main_handler",
      Description: "JOJO generic maintenance scheduler; GitHub execution and independent Healthchecks",
      Code: { ZipFile: code.toString("base64") }, MemorySize: 256, Timeout: 55,
      Environment: environment(stateToken, "shadow"), PublicNetConfig: { PublicNetStatus: "ENABLE", EipConfig: { EipStatus: "DISABLE" } },
      AutoCreateClsTopic: "TRUE", AutoDeployClsTopicIndex: "TRUE" });
    await waitActive();
    console.log("Created shadow function; no business dispatch or production heartbeat.");
  } else if (action === "deploy") {
    const info = await scf("GetFunction");
    if (info.Runtime !== "Nodejs20.19") throw new Error("Unexpected function runtime");
    await scf("UpdateFunctionCode", { ZipFile: (await readFile(`${here}/dist/function.zip`)).toString("base64"), Handler: "index.main_handler", CodeSource: "ZipFile" });
    await waitActive();
    console.log("Code deployed; existing mode, credentials and timer preserved.");
  } else if (action === "timer") {
    const current = await scf("ListTriggers");
    if (current.Triggers?.length) throw new Error("Timer already exists; inspect before changing");
    await scf("CreateTrigger", { TriggerName: "maintenance-minute", Type: "timer", TriggerDesc: "0 * * * * * *", Enable: "OPEN" });
    console.log("Native one-minute timer created.");
  } else if (action === "probe") {
    const result = await scf("Invoke", { InvocationType: "RequestResponse", ClientContext: JSON.stringify({ mode: "probe" }), LogType: "None" });
    console.log(JSON.stringify(verifiedProbe(result)));
  } else if (action === "arm") {
    const info = await scf("GetFunction");
    const vars = info.Environment.Variables.map((v) => v.Key === "SCHEDULER_MODE" ? { ...v, Value: "active" } : v);
    await scf("UpdateFunctionConfiguration", { Environment: { Variables: vars } });
    await waitActive();
    console.log("SCF armed; still fenced until the database backend is tencent.");
  } else if (action === "state-init") {
    const info = await scf("GetFunction");
    const stateToken = info.Environment.Variables.find((v) => v.Key === "SCHEDULER_STATE_TOKEN")?.Value;
    if (!stateToken) throw new Error("State credential missing");
    await sql("insert into private.maintenance_scheduler_secret(singleton,token_digest) values (true,sha256(convert_to($1,'UTF8'))) on conflict(singleton) do nothing", [stateToken], false);
    console.log("State credential registered; backend remains unchanged.");
  } else if (action === "activate") {
    const rows = await sql(`update private.maintenance_scheduler_control set backend='tencent', owner=null, lease_until=null, last_tick=null
      where singleton and backend='cloudflare' and imported_at > clock_timestamp()-interval '3 minutes'
      and (select count(*) from private.maintenance_scheduler_state where key in
        ('monitor:times-capture:monitor','monitor:times-process:monitor','monitor:rmrb-sync:monitor'))=3
      returning backend,imported_at`, [], false);
    if (rows.length !== 1) throw new Error("Activation refused: fresh complete CF snapshot required");
    console.log(JSON.stringify(rows));
  } else if (action === "logs") {
    const result = await scf("GetFunctionLogs", { Limit: 20 });
    console.log(JSON.stringify(result.Data?.map((item) => ({ startTime: item.StartTime, requestId: item.RequestId,
      duration: item.Duration, retCode: item.RetCode, retMsg: item.RetMsg, log: item.Log })) ?? result));
  } else { throw new Error("Usage: ops.mjs status|create-shadow|deploy|timer|probe|arm|state-init|activate|logs"); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode=1; });
}
