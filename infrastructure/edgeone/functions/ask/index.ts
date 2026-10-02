import { relayAskRequest } from "@jojo/agent/edgeone/relay";

/**
 * Unified Agent entry point for Web, Mobile and Desktop.
 *
 * A plain Edge Function, not a Makers `agents` route, so the platform runs no
 * preflight on it and browsers can reach it. Forwards to the internal `/rag`
 * route; see `@jojo/agent/edgeone/relay` for why the indirection is required.
 */
export async function onRequest(context: {
  env?: Readonly<Record<string, string | undefined>>;
  request: Request;
}): Promise<Response> {
  return relayAskRequest(context);
}
