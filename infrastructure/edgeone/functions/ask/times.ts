import { relayTimesRequest } from "@jojo/agent/edgeone/relay";

/** `/ask/times` — JOJO Times in-article explanation entry point. */
export async function onRequest(context: {
  env?: Readonly<Record<string, string | undefined>>;
  request: Request;
}): Promise<Response> {
  return relayTimesRequest(context);
}
