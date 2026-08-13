export type JojoDatasetType = "book" | "book-series" | "magazine" | "newspaper";
export type JojoItemType = "book" | "book-volume" | "magazine" | "newspaper";
export type JojoAssetType = "audio" | "image" | "pdf" | "video";
export type JojoPublicationStatus = "draft" | "published";
export type JojoContentAccess = "public" | "authenticated";

export interface JojoCatalogEntry {
  datasetId: string;
  type: JojoDatasetType;
  title: string;
  language: string;
  itemCount?: number;
  indexObject: string;
  publicationStatus?: JojoPublicationStatus;
  access?: JojoContentAccess;
}

export interface JojoCatalog {
  formatVersion: "jojo-catalog/1";
  revision: number;
  updatedAt: string;
  datasets: JojoCatalogEntry[];
}

export interface JojoDatasetItemSummary {
  itemId: string;
  itemKey: string;
  type: JojoItemType;
  order: number;
  title: string;
  manifestObject: string;
  publicationStatus?: JojoPublicationStatus;
  access?: JojoContentAccess;
}

export interface JojoDatasetIndex {
  formatVersion: "jojo-delivery-index/1";
  revision: number;
  datasetId: string;
  type: JojoDatasetType;
  title: string;
  language: string;
  description?: string;
  publicationStatus?: JojoPublicationStatus;
  access?: JojoContentAccess;
  items: JojoDatasetItemSummary[];
}

export interface JojoCanonicalDataset {
  formatVersion: "jojo-dataset/1";
  datasetId: string;
  type: JojoDatasetType;
  title: string;
  language: string;
  publicationStatus?: JojoPublicationStatus;
  access?: JojoContentAccess;
  description?: string;
  itemPath: string;
}

export interface JojoBody {
  format: "html" | "text";
  profile?: "jojo-semantic-html/1";
  value: string;
}

export interface JojoTocNode {
  id: string;
  order: number;
  title: string;
  targetId?: string;
  anchorId?: string;
  children?: JojoTocNode[];
}

export interface JojoObjectDescriptor {
  object: string;
  size: number;
  sha256: string;
}

export interface JojoChapterDescriptor extends JojoObjectDescriptor {
  id: string;
  order: number;
  title: string;
  characterCount: number;
}

export interface JojoAssetDescriptor extends JojoObjectDescriptor {
  id: string;
  type: JojoAssetType;
  role?: string;
  mediaType: string;
  title?: string | null;
  alt?: string | null;
  caption?: string | null;
  width?: number;
  height?: number;
  durationSeconds?: number;
  posterAssetId?: string;
  transcript?: string;
}

export interface JojoExportDescriptor extends JojoObjectDescriptor {
  id: string;
  format: "epub" | "pdf";
  mediaType: string;
  fileName: string;
}

export interface JojoBookSearchDescriptor extends JojoObjectDescriptor {
  format: "text";
  profile: "jojo-book-search/1";
}

export interface JojoBookSearchBlock {
  targetId: string;
  anchorId?: string;
  order: number;
  text: string;
}

export interface JojoBookSearchIndex {
  formatVersion: "jojo-book-search/1";
  itemId: string;
  blocks: JojoBookSearchBlock[];
}

export interface JojoContentStats {
  chapterCount: number;
  characterCount: number;
  canonicalCompressedSize?: number;
}

export interface JojoItemManifest {
  formatVersion: "jojo-item-manifest/1";
  revision: number;
  itemId: string;
  datasetId: string;
  type: JojoItemType;
  title: string;
  language: string;
  publicationStatus?: JojoPublicationStatus;
  access?: JojoContentAccess;
  identifiers?: Record<string, string | null>;
  metadata: Record<string, unknown>;
  content: {
    schema: "jojo-content/book/1" | "jojo-content/newspaper/1" | "jojo-content/magazine/1";
    toc?: JojoTocNode[];
    chapters?: JojoChapterDescriptor[];
    articles?: JojoChapterDescriptor[];
  };
  contentStats: JojoContentStats;
  search?: JojoBookSearchDescriptor;
  assets: JojoAssetDescriptor[];
  exports: JojoExportDescriptor[];
}

export interface JojoAnnotation {
  id: string;
  targetId: string;
  anchorId?: string;
  kind: "editor-note" | "endnote" | "footnote";
  label?: string;
  body: JojoBody;
}

export interface JojoFragment {
  formatVersion: "jojo-fragment/1";
  itemId: string;
  fragmentId: string;
  type: "article" | "chapter";
  order: number;
  title: string;
  body: JojoBody;
  assetRefs: string[];
  annotations: JojoAnnotation[];
}

export interface JojoCanonicalChapter {
  id: string;
  order: number;
  title: string;
  body: JojoBody;
  assetRefs: string[];
}

export interface JojoCanonicalPage {
  id: string;
  order: number;
  number: number | null;
  label: string;
  title: string | null;
  assetRefs: string[];
}

export interface JojoCanonicalArticle {
  id: string;
  order: number;
  title: string;
  authors: string[];
  body: JojoBody;
  assetRefs: string[];
}

export interface JojoCanonicalPlacement {
  id: string;
  pageId: string;
  articleId: string;
  order: number;
  role: "complete" | "start" | "continue";
}

export interface JojoCanonicalAsset extends Omit<JojoAssetDescriptor, "object"> {
  path: string;
  sourceUrl?: string;
}

export interface JojoCanonicalItem {
  formatVersion: "jojo-item/1";
  revision: number;
  itemId: string;
  datasetId: string;
  type: JojoItemType;
  title: string;
  language: string;
  publicationStatus?: JojoPublicationStatus;
  access?: JojoContentAccess;
  identifiers: Record<string, string | null>;
  metadata: Record<string, unknown>;
  content: {
    schema: "jojo-content/book/1";
    toc: JojoTocNode[];
    chapters: JojoCanonicalChapter[];
  } | {
    schema: "jojo-content/newspaper/1" | "jojo-content/magazine/1";
    pages: JojoCanonicalPage[];
    articles: JojoCanonicalArticle[];
    placements: JojoCanonicalPlacement[];
  };
  assets: JojoCanonicalAsset[];
  annotations: JojoAnnotation[];
  provenance: Record<string, unknown>;
  extensions: Record<string, unknown>;
}
