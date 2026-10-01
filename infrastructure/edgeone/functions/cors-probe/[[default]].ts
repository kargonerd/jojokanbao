/**
 * Temporary probe: does a plain edge function (not an `agents/` route) inside
 * the international Agent project survive a browser preflight? The `/rag` agent
 * route answers OPTIONS with 400 `Invalid makers-conversation-id` from the
 * platform layer, before any of our code runs. If this route answers 2xx, the
 * platform restriction is specific to `agents/` routes and a same-origin relay
 * under the Agent domain is viable.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, makers-conversation-id",
  "Access-Control-Max-Age": "86400",
};

export async function onRequest(context: { request: Request }): Promise<Response> {
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return Response.json(
    { probe: "cors-probe", method: context.request.method },
    { headers: CORS_HEADERS },
  );
}
