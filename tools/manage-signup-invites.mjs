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
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Environment variables set by the shell win. Otherwise .env.local overrides
// the shared root .env because it is loaded first.
loadEnvFile(".env.local");
loadEnvFile(".env");

async function runQuery(query, parameters = [], readOnly = false) {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!accessToken || !projectRef) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required in .env or .env.local.",
    );
  }

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        parameters,
        read_only: readOnly,
      }),
    },
  );
  const payload = await response.json();

  if (!response.ok || payload.error) {
    const message = payload.error
      ?? payload.message
      ?? `Supabase Management API returned ${response.status}.`;
    throw new Error(message);
  }

  return payload.result ?? payload;
}

async function createInvitation(args) {
  if (args.length > 0) {
    throw new Error("Usage: pnpm invite:create");
  }

  const rows = await runQuery(
    `select * from private.create_signup_invitation(
      null,
      interval '7 days',
      1,
      null
    );`,
  );
  const invitation = rows[0];

  if (!invitation) {
    throw new Error("Supabase did not return the new invitation.");
  }

  console.log(`邀请码: ${invitation.code}`);
  console.log("7 天内有效，仅可使用一次。");
}

async function listInvitations(args) {
  if (args.length > 0) {
    throw new Error(`Unexpected argument: ${args[0]}`);
  }

  const rows = await runQuery(
    `select
      id,
      code,
      kind,
      owner_user_id,
      email,
      expires_at,
      max_uses,
      use_count,
      disabled_at,
      note,
      created_at,
      updated_at
    from private.signup_invitations
    order by created_at desc
    limit 100;`,
    [],
    true,
  );
  console.table(rows);
}

async function revokeInvitation(args) {
  const invitationId = args[0];
  if (
    args.length !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      invitationId ?? "",
    )
  ) {
    throw new Error("Usage: pnpm invite:revoke -- <invitation-id>");
  }

  const rows = await runQuery(
    "select private.revoke_signup_invitation($1::uuid) as revoked;",
    [invitationId],
  );
  if (!rows[0]?.revoked) {
    throw new Error("Invitation not found.");
  }
  console.log(`已撤销邀请码 ${invitationId}`);
}

function printUsage() {
  console.log("Usage:");
  console.log("  pnpm invite:create");
  console.log("  pnpm invite:list");
  console.log("  pnpm invite:revoke -- <invitation-id>");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "create") await createInvitation(args);
  else if (command === "list") await listInvitations(args);
  else if (command === "revoke") await revokeInvitation(args);
  else {
    printUsage();
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
