/**
 * Agent endpoints live on the international Agent project; Reader's own APIs
 * live on the same origin as the Web client. They used to share one prefix
 * helper, which meant any future change of the Agent origin would also have
 * redirected the Reader APIs. They are now separate.
 */

/** Unified Agent entry point (`/ask`, `/ask/times`), shared by all clients. */
const configuredAgentBase = import.meta.env.VITE_AGENT_API_BASE?.trim().replace(/\/$/u, "")
  || "https://agent-global.jojokanbao.cn";

export type AgentAskPath =
  | "/ask"
  | "/ask/times";

/**
 * Absolute URL for the unified Agent entry point. Always absolute: the entry
 * lives on a different origin from the Web client, and unlike the previous
 * same-origin relay it is reached directly.
 */
export function agentAskUrl(path: AgentAskPath): string {
  return `${configuredAgentBase}${path}`;
}

/**
 * Reader-hosted APIs (speech, signup authorization). These stay on the Web
 * client's own origin — they are not served by the Agent project.
 */
export type ReaderApiPath =
  | "/api/v1/speech"
  | "/api/v1/speech/providers"
  | "/api/v1/account/signup-authorization";

const configuredReaderBase = import.meta.env.VITE_READER_API_BASE?.trim().replace(/\/$/u, "");

export function readerApiUrl(path: ReaderApiPath): string {
  return configuredReaderBase ? `${configuredReaderBase}${path}` : path;
}
