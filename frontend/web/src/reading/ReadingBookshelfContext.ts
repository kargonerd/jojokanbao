import { createContext } from "react";
import type { SpeechReadingPosition, SpeechLocation } from "@jojo/content";

export interface ReadingBookshelfControls {
  available: boolean;
  added: boolean;
  busy: boolean;
  toggle: () => void;
  speechLauncherTarget?: HTMLElement | null;
  chromeHidden?: boolean;
  paperColor?: "white" | "ivory" | "dark";
  getSpeechPosition?: () => SpeechReadingPosition | null;
  showSpeechLocation?: (location: SpeechLocation | null, reveal?: boolean) => void;
}

export const ReadingBookshelfContext = createContext<ReadingBookshelfControls | null>(null);
