import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  const accessToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return json(401, { error: "Authentication required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(500, { error: "Account service is not configured" });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData.user) return json(401, { error: "Authentication required" });

  const userId = userData.user.id;
  const { data: avatarObjects, error: listError } = await admin.storage.from("avatars").list(userId, { limit: 1000 });
  if (listError) return json(500, { error: "Unable to remove account files" });

  const avatarPaths = (avatarObjects ?? []).map((object) => `${userId}/${object.name}`);
  if (avatarPaths.length > 0) {
    const { error: storageError } = await admin.storage.from("avatars").remove(avatarPaths);
    if (storageError) return json(500, { error: "Unable to remove account files" });
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) return json(500, { error: "Unable to delete account" });
  return json(200, { deleted: true });
});
