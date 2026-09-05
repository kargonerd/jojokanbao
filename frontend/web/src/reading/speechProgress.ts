/** Browser-local listening history, deliberately separate from reading position. */
export interface SpeechProgress {
  chapterId?: string;
  fingerprint: string;
  segmentIndex: number;
  fraction: number;
  provider: string;
  voice: string;
  updatedAt: number;
}

const KEY = "jojo-speech-progress:v1";
const LIMIT = 100;

export function speechFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

function history(): Record<string, SpeechProgress> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, SpeechProgress> : {};
  } catch { return {}; }
}

export function readSpeechProgress(id: string): SpeechProgress | undefined {
  const value = history()[id];
  if (!value || typeof value.fingerprint !== "string" || !Number.isInteger(value.segmentIndex) || value.segmentIndex < 0
    || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1
    || typeof value.provider !== "string" || typeof value.voice !== "string"
    || (value.chapterId !== undefined && typeof value.chapterId !== "string")) return undefined;
  return value;
}

export function saveSpeechProgress(id: string, progress: SpeechProgress): void {
  try {
    const records = { ...history(), [id]: progress };
    const recent = Object.entries(records).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0)).slice(0, LIMIT);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch { /* Private browsing or a full quota must not interrupt audio. */ }
}
