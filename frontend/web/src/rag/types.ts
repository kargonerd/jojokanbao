export type RagReference = Record<string, unknown>;

export interface RagUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface RagStreamDone {
  conversationId?: string;
  usage?: RagUsage;
}

export interface RagNotebook {
  id: string;
  title?: string;
  name?: string;
  sources_count?: number;
}

export interface RagSource {
  id: string;
  title?: string;
  name?: string;
  published?: boolean;
}

export interface RagChapter {
  id: string;
  title: string;
}

export interface RagSourceDocument {
  title?: string;
  toc?: RagChapter[];
  notebook?: RagNotebook;
  source?: RagSource;
}

export interface RagMessage {
  role: "user" | "assistant";
  content: string;
  references?: RagReference[];
  usage?: RagUsage;
}

export interface RagAdminAccount {
  id: number;
  name: string;
  notebooks?: RagNotebook[];
  expires_at?: string | null;
  added_at?: string | null;
}

export interface RagAdminConfig {
  accounts: RagAdminAccount[];
  selected_notebooks: RagNotebook[];
}

export interface RagPerson {
  id?: string;
  name: string;
  aliases?: string[];
  role_summary?: string;
}

export type RagAnalysis = Record<string, unknown>;
