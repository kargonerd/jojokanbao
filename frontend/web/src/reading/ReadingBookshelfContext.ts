import { createContext } from "react";

export interface ReadingBookshelfControls {
  available: boolean;
  added: boolean;
  busy: boolean;
  toggle: () => void;
  speechLauncherTarget?: HTMLElement | null;
}

export const ReadingBookshelfContext = createContext<ReadingBookshelfControls | null>(null);
