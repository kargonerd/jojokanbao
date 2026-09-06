import type { StateStore } from "./types";

export interface StateEnv {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SCHEDULER_STATE_TOKEN: string;
}

export class SupabaseState {
  private readonly endpoint: string;
  constructor(private readonly env: StateEnv, readonly owner: string, private readonly fetcher = fetch) {
    const url = new URL(env.SUPABASE_URL);
    if (url.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/u.test(url.hostname) || url.username || url.password) {
      throw new Error("Invalid scheduler state endpoint");
    }
    if (!env.SUPABASE_PUBLISHABLE_KEY || env.SCHEDULER_STATE_TOKEN.length < 32) throw new Error("State credentials missing");
    this.endpoint = `${url.origin}/rest/v1/rpc/maintenance_scheduler_rpc`;
  }

  async rpc<T>(operation: string, key?: string, value?: unknown): Promise<T> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", apikey: this.env.SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ p_token: this.env.SCHEDULER_STATE_TOKEN, p_operation: operation,
        p_owner: this.owner, p_key: key ?? null, p_value: value ?? null }),
    });
    // Do not include request/response bodies: they can contain credentials or state.
    if (!response.ok) throw new Error(`Scheduler state ${operation}: HTTP ${response.status}`);
    return await response.json() as T;
  }

  claim(now: number): Promise<{ claimed: boolean; reason?: string }> {
    return this.rpc("claim", undefined, { tick: new Date(Math.floor(now / 60_000) * 60_000).toISOString() });
  }
  async release(): Promise<void> { await this.rpc("release"); }
  store(prefix: string): StateStore {
    return {
      get: async <T>(key: string) => (await this.rpc<{ value: T | null }>("get", `${prefix}:${key}`)).value ?? undefined,
      put: async <T>(key: string, value: T) => { await this.rpc("put", `${prefix}:${key}`, value); },
    };
  }
}
