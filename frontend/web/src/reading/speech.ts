import { createSpeechClient } from "@jojo/content/speech";
import { agentGatewayUrl } from "../api/agentGateway";
import { useAccountSessionStore } from "../account/session";

export { speechSegments, splitSpeechText } from "@jojo/content";
export { DEFAULT_SPEECH_PROVIDERS, SPEECH_VOICES, speechObjectBase, logicalSpeechVoice,
  type SpeechProvider, type SpeechVoice, type SpeechSource, type SpeechCapabilities } from "@jojo/content/speech";

const client = createSpeechClient({
  allowed: () => Boolean(useAccountSessionStore.getState().userId),
  apiUrl: agentGatewayUrl,
  digest: async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  },
});

export const { loadSpeechProviders, requestSpeech, loadCachedSpeechDurations, speechKey } = client;
