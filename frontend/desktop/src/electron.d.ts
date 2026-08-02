export {};

declare global {
  interface JojoPressBridge {
    appName: string;
    apiBaseUrl?: string;
    selectPdf?: () => Promise<string | null>;
  }

  interface Window {
    jojoPress?: JojoPressBridge;
  }
}
