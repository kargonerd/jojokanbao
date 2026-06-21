export interface Notebook {
  id: string
  notebook_id?: string
  title: string
  notebook_title?: string
  description?: string
  cover_url?: string
  accountName?: string
  account_name?: string
  source_count?: number
  is_published?: boolean
  sort_order?: number
  publish_ready?: boolean
  publish_reasons?: string[]
}

export interface SourceTocItem {
  id: string
  title: string
  chapter_id?: string
  level?: number
  order?: number
}

export interface SourceChapterSummary {
  id: string
  title: string
  order?: number
  summary?: string
}

export interface SourceAnnotation {
  id?: string
  chapter_id?: string
  anchor?: string
  quote?: string
  note?: string
  tags?: string[]
}

export interface ReaderConfig {
  font_size?: number
  line_height?: number
  content_width?: string
  theme?: string
  [key: string]: unknown
}

export interface Source {
  id: string
  source_id?: string
  notebook_id?: string
  title: string
  source_title?: string
  description?: string
  kind: string
  url?: string
  cover_url?: string
  has_document?: boolean
  markdown_url?: string
  document_status?: string
  document_mode?: string
  chapter_count?: number
  package_manifest?: Record<string, unknown>
  is_published?: boolean
  sort_order?: number
  publish_ready?: boolean
  publish_reasons?: string[]
}

export interface SourceDocument {
  id: string
  title: string
  text: string
  mode?: string
  document_url?: string | null
  toc?: SourceTocItem[]
  chapters?: SourceChapterSummary[]
  annotations?: SourceAnnotation[]
  reader_config?: ReaderConfig
  chapter_count?: number
  notebook?: Notebook
  source?: Source
}

export interface ChatReference {
  source_id: string
  citation_number: number
  cited_text: string | null
  start_char: number | null
  end_char: number | null
}

export interface ChatResponse {
  answer: string
  conversation_id: string
  turn_number: number
  is_follow_up: boolean
  references: ChatReference[]
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  references?: ChatReference[]
  timestamp: Date
}

export interface AdminAccount {
  id: number
  name: string
  notebooks: Array<{ id: string; title: string }>
  expires_at?: string
  added_at?: string
}

export interface PersonSummary {
  id: string
  name: string
  aliases?: string[]
  first_appearance?: string
  importance?: number
  mention_count?: number
  role_summary?: string
}

export interface PersonEvents {
  person: string
  full_profile?: string
  events: Array<{
    name: string
    date?: string
    location?: string
    description?: string
    significance?: string
    related_persons?: string[]
    source_section?: string
  }>
  role_changes?: Array<{
    period?: string
    role?: string
    position?: string
  }>
  relationships?: Array<{
    person?: string
    relationship?: string
    description?: string
  }>
}

export interface TimelineEvent {
  date: string
  title: string
  description: string
  sources?: string[]
}

export interface RelationsGraph {
  nodes: Array<{
    id: string
    name: string
    role?: string
    group?: string
    importance?: number
  }>
  links: Array<{
    source: string
    target: string
    relation: string
    strength?: number
  }>
}

