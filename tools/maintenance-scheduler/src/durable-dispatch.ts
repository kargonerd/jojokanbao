import { dispatchScheduledTask, type DispatchOptions, type DispatchResult } from "./dispatch";
import type { ScheduledTask, SchedulerEnv, StateStore } from "./types";

interface Delivery {
  slot: string;
  state: "sending" | "accepted" | "rejected";
  at: number;
}

/** Called under the shared tick lease. Keep one bounded delivery record per task. */
export async function durableDispatch(
  storage: StateStore, task: ScheduledTask, env: SchedulerEnv, options: DispatchOptions,
): Promise<DispatchResult> {
  const previous = await storage.get<Delivery>(task.id);
  const sameSlot = previous?.slot === options.slot.id;
  // A 2xx accepted run may not be visible in GitHub's list yet. For retryable
  // daily tasks wait for list visibility; do not rely on time elapsed alone.
  let reconcileOnly = !!sameSlot && ["sending", "accepted"].includes(previous.state);
  const fetcher = options.fetcher ?? fetch;
  return dispatchScheduledTask(task, env, {
    ...options,
    fetcher: async (input, init) => {
      const response = await fetcher(input, init);
      if (sameSlot && previous && ["accepted", "sending"].includes(previous.state) && String(input).endsWith("/runs?per_page=50") && response.ok) {
        const body = await response.clone().json() as { workflow_runs?: Array<{ display_title?: string; created_at?: string; status?: string }> };
        // A visible, completed failed run can now be evaluated by the normal
        // retry policy (including maxAttempts and retryDelayMinutes).
        if (body.workflow_runs?.some((run) => run.display_title === task.automaticRunTitle && run.status === "completed"
          && Date.parse(run.created_at ?? "") >= Math.floor(previous.at / 1000) * 1000 && Date.parse(run.created_at ?? "") < options.slot.endsAtMs)) {
          reconcileOnly = false;
        }
      }
      return response;
    },
    get reconcileOnly() { return reconcileOnly; },
    beforePost: async () => {
      await storage.put<Delivery>(task.id, { slot: options.slot.id, state: "sending", at: options.observedAtMs });
    },
    afterPost: async (status) => {
      // A server/proxy error may occur after GitHub accepted the request.
      const state = status >= 200 && status < 300 ? "accepted"
        : status >= 400 && status < 500 && ![408, 409, 425].includes(status) ? "rejected" : "sending";
      await storage.put<Delivery>(task.id, { slot: options.slot.id, state, at: options.observedAtMs });
    },
  });
}
