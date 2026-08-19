export {};

declare global {
  type EngineBridgeResult =
    | { ok: true; value: unknown }
    | { ok: false; error: { status: number; message: string } };

  interface JojoDesktopBridge {
    appName: string;
    platform?: NodeJS.Platform;
    getAppInfo?: () => Promise<{ version: string; platform: string; arch: string }>;
    selectPdf?: () => Promise<string | null>;
    setFeatureAvailability?: (features: { rag: boolean }) => void;
    onNavigate?: (callback: (path: string) => void) => () => void;
    onCloseChoiceRequested?: (callback: () => void) => () => void;
    respondToCloseChoice?: (choice: 'tray' | 'quit' | 'cancel') => void;
    settings?: {
      getCloseBehavior: () => Promise<'ask' | 'tray' | 'quit'>;
      saveCloseBehavior: (behavior: 'ask' | 'tray' | 'quit') => Promise<'ask' | 'tray' | 'quit'>;
      getLaunchAtLogin: () => Promise<boolean>;
      saveLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
      getMineru: () => Promise<{ configured: boolean }>;
      saveMineru: (token: string) => Promise<{ configured: boolean }>;
    };
    engine: {
      invoke: (command: string, payload?: Record<string, unknown>) => Promise<EngineBridgeResult>;
    };
  }

  interface Window {
    jojoDesktop?: JojoDesktopBridge;
  }
}
