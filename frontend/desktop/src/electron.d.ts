export {};

declare global {
  interface JojoDesktopBridge {
    appName: string;
    platform?: NodeJS.Platform;
    getAppInfo?: () => Promise<{ version: string; platform: string; arch: string }>;
    setFeatureAvailability?: (features: { rag: boolean }) => void;
    onNavigate?: (callback: (path: string) => void) => () => void;
    onCloseChoiceRequested?: (callback: () => void) => () => void;
    respondToCloseChoice?: (choice: 'tray' | 'quit' | 'cancel') => void;
    settings?: {
      getCloseBehavior: () => Promise<'ask' | 'tray' | 'quit'>;
      saveCloseBehavior: (behavior: 'ask' | 'tray' | 'quit') => Promise<'ask' | 'tray' | 'quit'>;
      getLaunchAtLogin: () => Promise<boolean>;
      saveLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
    };
  }

  interface Window {
    jojoDesktop?: JojoDesktopBridge;
  }
}
