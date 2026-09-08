import { describe, expect, it } from "vitest";
import { speechCueAt, validateSpeechCues } from "../src/speech-timing";
import { createSpeechClient } from "../src/speech-client";
import { vi, afterEach } from "vitest";

const cues = [{ start: 0.2, end: 3, startOffset: 0, endOffset: 3 }, { start: 4, end: 8, startOffset: 3, endOffset: 7 }];
const timing = { formatVersion: "jojo-speech-sentences/1", audioSha256: "a".repeat(64), textSha256: "text-hash", cues };
afterEach(() => vi.unstubAllGlobals());

describe("recorded sentence timing", () => {
  it("follows media seconds across pauses, speed changes and seeks, including silence between sentences", () => {
    expect(speechCueAt(cues, 0)).toBe(cues[0]);
    expect(speechCueAt(cues, 3.8)).toBe(cues[0]);
    expect(speechCueAt(cues, 4)).toBe(cues[1]);
    expect(speechCueAt(cues, 8)).toBe(cues[1]);
    expect(speechCueAt(cues, 1)).toBe(cues[0]);
    expect(speechCueAt(undefined, 4)).toBeUndefined();
  });

  it("accepts only a complete timeline bound to the exact text and audio", () => {
    const validate = (record: unknown) => validateSpeechCues(record, timing.audioSha256, timing.textSha256, 7, 9);
    expect(validate(timing)).toEqual(cues);
    expect(validate({ ...timing, audioSha256: "b".repeat(64) })).toBeNull();
    expect(validate({ ...timing, textSha256: "wrong-text" })).toBeNull();
    expect(validate({ ...timing, cues: cues.slice(0, 1) })).toBeNull();
    expect(validate({ ...timing, cues: [cues[0], { ...cues[1], start: 2 }] })).toBeNull();
    expect(validate({ ...timing, cues: [cues[0], { ...cues[1], end: 90 }] })).toBeNull();
    expect(validate({ ...timing, cues: [cues[0], { ...cues[1], startOffset: 4 }] })).toBeNull();
  });

  it("reads the immutable-audio sidecar without synthesizing and treats missing data as unavailable", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(timing)).mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const client = createSpeechClient({ allowed: () => true, apiUrl: (path) => path, digest: async () => "text-hash" });
    const source = { url: `https://cdn.example/audio/speech/v1/segments/mimo/aa/${"a".repeat(64)}/${"a".repeat(64)}.mp3`, duration: 9 };
    expect(await client.loadSpeechCues(source, "第一。 第二句话", new AbortController().signal)).toEqual(cues);
    expect(String(fetch.mock.calls[0]![0])).toContain(".sentences-v1.json");
    expect(await client.loadSpeechCues(source, "第一。第二句话", new AbortController().signal)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
