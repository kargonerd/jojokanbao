import { createSpeechClient } from "@jojo/content";
import { agentGatewayUrl } from "../api/agentGateway";
import { useAccountSessionStore } from "../account/session";
import { useFeatureFlagStore } from "../featureFlags";

export { DEFAULT_SPEECH_PROVIDERS, SPEECH_VOICES, speechObjectBase, speechSegments, splitSpeechText,
  type SpeechProvider, type SpeechVoice, type SpeechSource, type SpeechCapabilities } from "@jojo/content";

const client = createSpeechClient({
  allowed: () => Boolean(useAccountSessionStore.getState().userId && useFeatureFlagStore.getState().flags["reader.speech"]),
  apiUrl: agentGatewayUrl,
  digest: async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  },
});

export const { loadSpeechProviders, requestSpeech, loadCachedSpeechDurations, speechKey } = client;
