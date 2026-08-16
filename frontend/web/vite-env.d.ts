/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PLATFORM_REDESIGN?: string;
  readonly VITE_ENABLE_ACCOUNT?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_ENABLE_OLDS?: string;
  readonly VITE_ENABLE_RAG?: string;
  readonly VITE_OLDS_API_BASE?: string;
  readonly VITE_RAG_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
