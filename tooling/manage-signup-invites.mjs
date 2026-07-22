import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;

if (!accessToken || !projectRef) {
  throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required in .env.local or .env.");
}

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (inlineValue === undefined) index += 1;
    options.set(rawKey, value);
  }
  return options;
}

async function runQuery(query, parameters = [], readOnly = false) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, parameters, read_only: readOnly }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const message = payload.error ?? payload.message ?? `Supabase Management API returned ${response.status}.`;
    throw new Error(message);
  }
  return payload.result ?? payload;
}

async function createInvitation(args) {
  const options = parseOptions(args);
  const email = options.get("email") || null;
  const days = Number.parseInt(options.get("days") ?? "7", 10);
  const maxUses = Number.parseInt(options.get("uses") ?? "1", 10);
  const note = options.get("note") || null;

  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer between 1 and 365.");
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    throw new Error("--uses must be an integer between 1 and 1000.");
  }

  const rows = await runQuery(
    `select * from private.create_signup_invitation(
      $1::text,
      make_interval(days => $2::integer),
      $3::integer,
      $4::text
    );`,
    [email, days, maxUses, note],
  );
  const invitation = rows[0];
  if (!invitation) throw new Error("Supabase did not return the new invitation.");

  console.log(`邀请码: ${invitation.code}`);
  console.log(`ID: ${invitation.invitation_id}`);
  console.log(`到期时间: ${invitation.expires_at}`);
  console.log(`绑定邮箱: ${email ?? "未绑定"}`);
  console.log(`可用次数: ${maxUses}`);
  console.log("请立即安全发送邀请码；数据库不会保存明文。");
}

async function listInvitations() {
  const rows = await runQuery(
    `select
      id,
      email,
      expires_at,
      max_uses,
      use_count,
      disabled_at,
      note,
      created_at
    from private.signup_invitations
    order by created_at desc
    limit 100;`,
    [],
    true,
  );
  console.table(rows);
}

async function revokeInvitation(args) {
  const invitationId = args.find((argument) => !argument.startsWith("--"));
  if (!invitationId) throw new Error("Usage: pnpm invite:revoke -- <invitation-id>");
  const rows = await runQuery(
    "select private.revoke_signup_invitation($1::uuid) as revoked;",
    [invitationId],
  );
  if (!rows[0]?.revoked) throw new Error("Invitation not found.");
  console.log(`已撤销邀请码 ${invitationId}`);
}

const [command, ...args] = process.argv.slice(2);

if (command === "create") await createInvitation(args);
else if (command === "list") await listInvitations();
else if (command === "revoke") await revokeInvitation(args);
else {
  console.log("Usage:");
  console.log("  pnpm invite:create -- --email reader@example.com --days 7 --uses 1 --note early-reader");
  console.log("  pnpm invite:list");
  console.log("  pnpm invite:revoke -- <invitation-id>");
  process.exitCode = 1;
}
