export const EMAIL_MONITOR_SLUG = "jojo-email-delivery";
export const EMAIL_BODY_LIMIT = 64 * 1024;
export const EMAIL_MESSAGE_LIMIT = 200;
export const EMAIL_STATUSES = ["queued", "scheduled", "sent", "delivered", "delivery_delayed", "bounced", "failed", "complained", "suppressed", "opened", "clicked", "canceled"] as const;
export type EmailStatus = typeof EMAIL_STATUSES[number];
export interface EmailMessage { id: string; createdAt: string; status: EmailStatus }
export type TransportProbe = { outcome: "not_run"; at: string } | { outcome: "success"; at: string; messageId: string } | { outcome: "failure"; at: string; reason: string; messageId?: string };
export interface EmailObservation {
  mail_observation: "v1";
  task: typeof EMAIL_MONITOR_SLUG;
  runId: string;
  runAttempt: string;
  run: string;
  eventTime: string;
  scanStart: string;
  scanComplete: boolean;
  scanError?: string;
  messages: EmailMessage[];
  transportProbe: TransportProbe;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const safeCode = /^[a-z][a-z0-9_]{0,79}$/u;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function time(value: unknown): number { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : Number.NaN; }
function id(value: unknown): boolean { return typeof value === "string" && value.length === 36 && uuid.test(value); }

/** Only the private workflow observation schema is accepted in this inbox. */
export function parseEmailObservation(body: string, receivedAt: number): EmailObservation {
  const invalid = () => new Error("Invalid email monitoring observation");
  if (new TextEncoder().encode(body).byteLength > EMAIL_BODY_LIMIT) throw invalid();
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw invalid(); }
  if (!object(value) || !keys(value, ["mail_observation", "task", "runId", "runAttempt", "run", "eventTime", "scanStart", "scanComplete", "scanError", "messages", "transportProbe"]) ||
    value.mail_observation !== "v1" || value.task !== EMAIL_MONITOR_SLUG ||
    typeof value.runId !== "string" || !/^[1-9][0-9]*$/u.test(value.runId) ||
    typeof value.runAttempt !== "string" || !/^[1-9][0-9]*$/u.test(value.runAttempt) ||
    typeof value.run !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/[1-9][0-9]*$/u.test(value.run) || !value.run.endsWith(`/runs/${value.runId}`) ||
    typeof value.scanComplete !== "boolean" || !Array.isArray(value.messages) || value.messages.length > EMAIL_MESSAGE_LIMIT) throw invalid();
  const at = time(value.eventTime);
  const scanStart = time(value.scanStart);
  if (!Number.isFinite(receivedAt) || !Number.isFinite(at) || !Number.isFinite(scanStart) || at > receivedAt + 60_000 || scanStart > at || at - scanStart > 7 * 86_400_000 ||
    (value.scanComplete ? value.scanError !== undefined : typeof value.scanError !== "string" || !safeCode.test(value.scanError))) throw invalid();
  const ids = new Set<string>();
  for (const message of value.messages) {
    if (!object(message) || !keys(message, ["id", "createdAt", "status"]) || !id(message.id) || ids.has(message.id as string) ||
      !EMAIL_STATUSES.includes(message.status as EmailStatus) || !Number.isFinite(time(message.createdAt)) || time(message.createdAt) < scanStart || time(message.createdAt) > at + 60_000) throw invalid();
    ids.add(message.id as string);
  }
  const probe = value.transportProbe;
  if (!object(probe)) throw invalid();
  const probeAt = time(probe.at);
  if (!Number.isFinite(probeAt) || probeAt < scanStart || probeAt > at + 60_000) throw invalid();
  if (probe.outcome === "not_run") {
    if (!keys(probe, ["outcome", "at"])) throw invalid();
  } else if (probe.outcome === "success" || probe.outcome === "failure") {
    if (probe.outcome === "success" ? !keys(probe, ["outcome", "at", "messageId"]) || !id(probe.messageId)
      : !keys(probe, ["outcome", "at", "reason", "messageId"]) || typeof probe.reason !== "string" || !safeCode.test(probe.reason)
        || (probe.messageId !== undefined && !id(probe.messageId))) throw invalid();
  } else throw invalid();
  return value as unknown as EmailObservation;
}
