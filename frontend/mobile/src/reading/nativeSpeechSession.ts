import type { AudioPlayer } from "expo-audio";

export interface LockScreenPlaybackState {
  chapterId: string;
  duration: number;
  position: number;
  playing: boolean;
  buffering: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
}

export interface LockScreenPlaybackRequest {
  chapterId: string;
  action: "play" | "pause" | "previous" | "next" | "seek";
  position?: number;
}

interface ChapterMediaPlayer {
  updateLockScreenPlayback(state: LockScreenPlaybackState | null): void;
  addListener(event: "lockScreenPlaybackRequest", listener: (request: LockScreenPlaybackRequest) => void): { remove(): void };
}

/** Older installed binaries can still receive OTA metadata and basic controls. */
export function chapterMediaPlayer(player: AudioPlayer): ChapterMediaPlayer | undefined {
  const candidate = player as unknown as Partial<ChapterMediaPlayer>;
  return typeof candidate.updateLockScreenPlayback === "function" ? candidate as ChapterMediaPlayer : undefined;
}
