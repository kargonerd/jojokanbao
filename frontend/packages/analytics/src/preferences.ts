import { analytics } from "./index";

export const ANALYTICS_PREFERENCE_KEY = "jojo.analytics.enabled.v1";
const preferenceEvent = "jojo-analytics-preference";

export function browserAnalyticsEnabled(): boolean {
  try { return localStorage.getItem(ANALYTICS_PREFERENCE_KEY) !== "false"; }
  catch { return false; }
}
export function setBrowserAnalyticsEnabled(enabled: boolean): void {
  try { localStorage.setItem(ANALYTICS_PREFERENCE_KEY, String(enabled)); } catch { /* Session-only preference. */ }
  analytics.setConsent(enabled);
  window.dispatchEvent(new Event(preferenceEvent));
}
export function subscribeBrowserAnalytics(callback: () => void): () => void {
  window.addEventListener(preferenceEvent, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(preferenceEvent, callback);
    window.removeEventListener("storage", callback);
  };
}
