export interface ConfigSession {
  cached(): unknown;
  subscribe(listener: (value: unknown) => void): () => void;
  refresh(): void;
  dispose(): void;
}

export const CONFIG_REFRESH_INTERVAL_MS = 5 * 60_000;
export function configStorageNamespace(token: string, host: string): string {
  return `jojo.config.v1.${encodeURIComponent(`${host}:${token}:support`)}`;
}
