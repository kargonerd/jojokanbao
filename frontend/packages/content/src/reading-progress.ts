export interface ReadingChapter { id: string; characterCount?: number }

function chapterWeights(chapters: readonly ReadingChapter[]): number[] {
  const known = chapters.filter((chapter) => Number.isFinite(chapter.characterCount) && chapter.characterCount! > 0);
  const fallback = known.length ? known.reduce((sum, chapter) => sum + chapter.characterCount!, 0) / known.length : 1;
  // Give covers and image-only chapters a small navigable interval.
  return chapters.map((chapter) => Number.isFinite(chapter.characterCount) && chapter.characterCount! >= 0
    ? Math.max(1, chapter.characterCount!) : fallback);
}

function boundedPercent(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0; }

export function bookProgressPercent(chapters: readonly ReadingChapter[], chapterId: string, chapterProgress: number): number {
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return 0;
  const weights = chapterWeights(chapters);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return (weights.slice(0, index).reduce((sum, weight) => sum + weight, 0) + weights[index]! * boundedPercent(chapterProgress) / 100) / total * 100;
}

export function bookProgressLocation(chapters: readonly ReadingChapter[], percent: number): { chapterId: string; chapterProgress: number } | undefined {
  if (!chapters.length) return undefined;
  const weights = chapterWeights(chapters);
  let offset = weights.reduce((sum, weight) => sum + weight, 0) * boundedPercent(percent) / 100;
  for (let index = 0; index < chapters.length; index += 1) {
    if (offset < weights[index]! || index === chapters.length - 1) {
      return { chapterId: chapters[index]!.id, chapterProgress: boundedPercent(offset / weights[index]! * 100) };
    }
    offset -= weights[index]!;
  }
  return undefined;
}

export function formatReadingTime(seconds: number): string {
  const minutes = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds / 60)) : 0;
  if (!minutes) return "不足1分钟";
  return minutes < 60 ? `${minutes}分钟` : `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}`;
}

export function estimatedReadingMinutes(characterCount: number, progressPercent: number): number {
  const count = Number.isFinite(characterCount) ? Math.max(0, characterCount) : 0;
  return Math.max(0, Math.ceil(count * (1 - boundedPercent(progressPercent) / 100) / 500));
}
