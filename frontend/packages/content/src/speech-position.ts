/** Offsets count non-whitespace characters in the readable DOM text. */
export interface SpeechReadingPosition { text: string; offset: number }
export interface SpeechLocation { chapterId: string; segments: string[]; index: number }

export function compactSpeechText(text: string): string { return text.replace(/\s/gu, ""); }

/** Match in sequence so repeated sentences keep their own position. */
export function speechSegmentOffsets(text: string, segments: readonly string[]): number[] {
  let cursor = 0;
  return segments.map((segment) => {
    const start = text.indexOf(compactSpeechText(segment), cursor);
    if (start >= 0) cursor = start + compactSpeechText(segment).length;
    return start;
  });
}

/** Only the entry segment is split; subsequent audio keeps its existing cache keys. */
export function speechFromReadingPosition(segments: string[], position?: SpeechReadingPosition | null): { segments: string[]; index: number } {
  if (!position || position.offset <= 0) return { segments, index: 0 };
  const offsets = speechSegmentOffsets(position.text, segments);
  const index = offsets.findIndex((start, i) => start >= 0 && start + compactSpeechText(segments[i]!).length > position.offset);
  if (index < 0) return { segments, index: Math.max(0, segments.length - 1) };
  const segment = segments[index]!;
  const compact = compactSpeechText(segment);
  let offset = Math.max(0, position.offset - offsets[index]!);
  const visibleOffset = offset;
  // Keep a complete sentence already at the top of the page; otherwise skip its tail.
  if (offset > 0 && !/[。！？!?；;.][”’」』"']*$/u.test(compact.slice(0, offset))) {
    const ending = /[。！？!?；;]|\.(?=[”’"']|[A-Z]|$)/u.exec(compact.slice(offset));
    if (ending) offset += ending.index + ending[0].length;
  }
  while (/[”’」』"']/u.test(compact[offset] ?? "") && offset < compact.length) offset++;
  if (offset >= compact.length) {
    if (index + 1 < segments.length) return { segments, index: index + 1 };
    // At the very end, read the final complete sentence instead of rewinding the whole chunk.
    const previous = [...compact.slice(0, visibleOffset).matchAll(/[。！？!?；;][”’」』"']*/gu)].at(-1);
    offset = previous ? previous.index! + previous[0].length : 0;
  }
  if (!offset) return { segments, index };
  let rawOffset = 0;
  let count = 0;
  while (rawOffset < segment.length && count < offset) {
    if (!/\s/u.test(segment[rawOffset]!)) count++;
    rawOffset++;
  }
  const result = [...segments];
  result.splice(index, 1, segment.slice(0, rawOffset).trim(), segment.slice(rawOffset).trim());
  return { segments: result, index: index + 1 };
}
