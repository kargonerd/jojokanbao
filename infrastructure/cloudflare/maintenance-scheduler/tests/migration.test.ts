import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/index";
import { MaintenanceMonitor } from "../src/monitor-object";
import type { SchedulerEnv } from "../src/types";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("one-way state handoff", () => {
  it("exports exact actor data without invoking monitoring", async () => {
    const value = {cursor:123,down:true,executionFailures:2};
    const actor = new MaintenanceMonitor({storage:{ get: async (key:string) => key === "monitor" ? value : undefined }} as unknown as DurableObjectState, {} as SchedulerEnv);
    expect(await (await actor.fetch(new Request("https://monitor.internal/snapshot"))).json()).toEqual({monitor:value});
  });
  it("export mode cannot dispatch workflows or write Healthchecks", async () => {
    const snapshots = vi.fn(async () => Response.json({monitor:{cursor:42,down:true}}));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({importedAt:"now"}));
    vi.stubGlobal("fetch",fetcher); vi.spyOn(console,"log").mockImplementation(()=>{});
    const env = { SCHEDULER_BACKEND:"migration-export", SUPABASE_URL:"https://testref.supabase.co", SUPABASE_PUBLISHABLE_KEY:"public", SCHEDULER_STATE_TOKEN:"test",
      MONITORS:{idFromName:(name:string)=>name,get:()=>({fetch:snapshots})} } as unknown as SchedulerEnv;
    await handleScheduled({scheduledTime:Date.now(),cron:"* * * * *"} as ScheduledController,env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.redirect).toBe("manual");
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://testref.supabase.co/rest/v1/rpc/maintenance_scheduler_rpc");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).p_value.states["monitor:times-process:monitor"]).toEqual({cursor:42,down:true});
  });
  it("disabled CF is a no-op", async () => {
    const fetcher=vi.fn(); vi.stubGlobal("fetch",fetcher);
    await handleScheduled({scheduledTime:Date.now()} as ScheduledController,{SCHEDULER_BACKEND:"disabled"} as SchedulerEnv);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
