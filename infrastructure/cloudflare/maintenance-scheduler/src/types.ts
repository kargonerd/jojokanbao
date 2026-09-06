export * from "../../../../tools/maintenance-scheduler/src/types";
import type { SchedulerEnv as CoreEnv } from "../../../../tools/maintenance-scheduler/src/types";
export interface SchedulerEnv extends CoreEnv {
  MONITORS?: DurableObjectNamespace;
  SCHEDULER_BACKEND?: "cloudflare" | "migration-export" | "disabled";
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SCHEDULER_STATE_TOKEN?: string;
}
