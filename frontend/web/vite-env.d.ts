/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PLATFORM_REDESIGN?: string;
  readonly VITE_RELEASE_CHANNEL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_CONTENT_CDN_BASE?: string;
  readonly VITE_RELEASE_CDN_BASE?: string;
  readonly VITE_AGENT_GATEWAY_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
