export {};

declare global {
  type EngineBridgeResult =
    | { ok: true; value: unknown }
    | { ok: false; error: { status: number; message: string } };

  interface JojoDesktopBridge {
    appName: string;
    selectPdf?: () => Promise<string | null>;
    onNavigate?: (callback: (path: string) => void) => () => void;
    settings?: {
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
