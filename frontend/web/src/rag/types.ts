export interface RagReference {
  citationId?: string;
  datasetId?: string;
  itemId?: string;
  datasetTitle?: string;
  itemTitle?: string;
  targetId?: string;
  anchorId?: string;
  title?: string;
  excerpt?: string;
  fragmentObject?: string;
}

export interface RagSearchHit extends RagReference {
  datasetId: string;
  itemId: string;
  targetId: string;
  targetTitle: string;
  text: string;
  highlights?: string[];
  score?: number;
}

export interface RagNotebook {
  id: string;
  title?: string;
  name?: string;
  sources_count?: number;
  type?: string;
  indexObject?: string;
  aiEnabled?: boolean;
}

export interface RagSource {
  id: string;
  title?: string;
  name?: string;
  published?: boolean;
  itemId?: string;
  itemKey?: string;
  manifestObject?: string;
}

export interface RagMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  references?: RagReference[];
}

export interface RagFocusContext {
  chapterId: string;
  chapterTitle?: string;
  quote: string;
  prefix?: string;
  suffix?: string;
}

export interface RagAnswerMetadata {
  provider?: string;
  model?: string;
}

export interface RagConversationScope {
  mode?: "all" | "selected";
  datasetIds?: string[];
  itemIds?: string[];
  manifestObjects?: string[];
}

export interface RagConversationSummary {
  id: string;
  title: string;
  createdAt?: number;
  lastMessageAt?: number;
  messageCount: number;
  scope?: RagConversationScope;
}

export interface RagConversationDetail {
  conversation: RagConversationSummary;
  messages: RagMessage[];
}
