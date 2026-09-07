import { clearPreloadedSource, preload } from "expo-audio";

/** Native byte buffering, not just metadata fetching. At most two downloads at once. */
export class AudioPrefetch {
  private desired = new Set<string>();
  private records = new Map<string, "pending" | "ready">();
  private queue: string[] = [];
  private running = 0;

  retain(current?: string, next: string[] = []) {
    this.desired = new Set([...(current ? [current] : []), ...next]);
    this.queue = next.filter((url) => !this.records.has(url));
    for (const [url, state] of this.records) {
      if (!this.desired.has(url) && state === "ready") this.release(url);
    }
    this.pump();
  }

  private release(url: string) {
    this.records.delete(url);
    void clearPreloadedSource({ uri: url }).catch(() => undefined);
  }

  private pump() {
    while (this.running < 2 && this.queue.length) {
      const url = this.queue.shift()!;
      if (this.records.has(url) || !this.desired.has(url)) continue;
      this.running++;
      this.records.set(url, "pending");
      void preload({ uri: url }, { preferredForwardBufferDuration: 30 }).then(() => {
        this.records.set(url, "ready");
        if (!this.desired.has(url)) this.release(url);
      }).catch(() => { this.records.delete(url); }).finally(() => { this.running--; this.pump(); });
    }
  }
}
