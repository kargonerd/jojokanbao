export type JojoDatasetType = "book" | "book-series" | "magazine" | "newspaper";
export type JojoItemType = "book" | "book-volume" | "periodical-issue";
export type JojoAssetType = "audio" | "image" | "pdf" | "video";

export interface JojoCatalogEntry {
  datasetId: string;
  type: JojoDatasetType;
  title: string;
  language: string;
  itemCount?: number;
  indexObject: string;
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
}

export interface JojoDatasetIndex {
  formatVersion: "jojo-dataset/1";
  revision: number;
  datasetId: string;
  type: JojoDatasetType;
  title: string;
  language: string;
  description?: string;
  items: JojoDatasetItemSummary[];
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
  identifiers?: Record<string, string | null>;
  metadata: Record<string, unknown>;
  content: {
    schema: "jojo-content/book/1" | "jojo-content/periodical-issue/1";
    toc?: JojoTocNode[];
    chapters?: JojoChapterDescriptor[];
  };
  contentStats: JojoContentStats;
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
  identifiers: Record<string, string | null>;
  metadata: Record<string, unknown>;
  content: {
    schema: "jojo-content/book/1";
    toc: JojoTocNode[];
    chapters: JojoCanonicalChapter[];
  };
  assets: JojoCanonicalAsset[];
  annotations: JojoAnnotation[];
  provenance: Record<string, unknown>;
  extensions: Record<string, unknown>;
}
