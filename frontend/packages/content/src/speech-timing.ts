/** Text offsets count UTF-16 characters after removing whitespace, like the reader bridge. */
export interface SpeechCue { start: number; end: number; startOffset: number; endOffset: number }

export function speechCueAt(cues: readonly SpeechCue[] | undefined, seconds: number): SpeechCue | undefined {
  if (!cues?.length || !Number.isFinite(seconds)) return undefined;
  let selected = cues[0];
  for (const cue of cues) {
    if (cue.start > seconds) break;
    selected = cue;
  }
  return selected;
}

/** Reject mismatched audio/text, partial coverage, and non-monotonic timelines. */
export function validateSpeechCues(value: unknown, audioSha256: string, textSha256: string, textLength: number, duration: number): SpeechCue[] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== "jojo-speech-sentences/1" || record.audioSha256 !== audioSha256
    || record.textSha256 !== textSha256 || !Array.isArray(record.cues) || !record.cues.length || record.cues.length > 600) return null;
  let offset = 0, time = 0;
  const cues: SpeechCue[] = [];
  for (const item of record.cues) {
    if (!item || typeof item !== "object") return null;
    const cue = item as SpeechCue;
    if (![cue.start, cue.end, cue.startOffset, cue.endOffset].every(Number.isFinite)
      || !Number.isInteger(cue.startOffset) || !Number.isInteger(cue.endOffset)
      || cue.startOffset !== offset || cue.endOffset <= offset || cue.endOffset > textLength
      || cue.start < time || cue.end <= cue.start || cue.end > duration + 0.1) return null;
    cues.push({ start: cue.start, end: cue.end, startOffset: cue.startOffset, endOffset: cue.endOffset });
    offset = cue.endOffset; time = cue.end;
  }
  return offset === textLength ? cues : null;
}
