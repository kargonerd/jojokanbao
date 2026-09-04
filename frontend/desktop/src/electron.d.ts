export {};

declare global {
  type DesktopUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';

  interface DesktopUpdateState {
    supported: boolean;
    phase: DesktopUpdatePhase;
    currentVersion: string;
    availableVersion?: string;
    progress?: number;
    message: string;
    checkedAt?: string;
  }

  interface JojoDesktopBridge {
    appName: string;
    platform?: NodeJS.Platform;
    getAppInfo?: () => Promise<{ version: string; platform: string; arch: string }>;
    setFeatureAvailability?: (features: { rag: boolean; times: boolean }) => void;
    onNavigate?: (callback: (path: string) => void) => () => void;
    onCloseChoiceRequested?: (callback: () => void) => () => void;
    respondToCloseChoice?: (choice: 'tray' | 'quit' | 'cancel') => void;
    settings?: {
      getCloseBehavior: () => Promise<'ask' | 'tray' | 'quit'>;
      saveCloseBehavior: (behavior: 'ask' | 'tray' | 'quit') => Promise<'ask' | 'tray' | 'quit'>;
      getLaunchAtLogin: () => Promise<boolean>;
      saveLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
    };
    updates?: {
      getState: () => Promise<DesktopUpdateState>;
      check: () => Promise<DesktopUpdateState>;
      install: () => Promise<void>;
      onState: (callback: (state: DesktopUpdateState) => void) => () => void;
    };
  }

  interface Window {
    jojoDesktop?: JojoDesktopBridge;
  }
}
