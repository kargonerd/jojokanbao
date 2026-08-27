export type AnnotationContentType = "book" | "newspaper" | "magazine" | "article";

export interface AnnotationSubject {
  contentType: AnnotationContentType;
  contentId: string;
  sectionId: string;
  contentTitle: string;
  contentUrl?: string;
}

export interface TextAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number | null;
  endOffset: number | null;
}

export type AnnotationVisibility = "public" | "private";

export interface AnnotationComment {
  id: string;
  annotationId: string;
  parentCommentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  visibility: AnnotationVisibility;
  createdAt: string;
  reportedByMe: boolean;
}

export interface AnnotationThread extends AnnotationSubject, TextAnchor {
  id: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  comments: AnnotationComment[];
}

export type AnnotationReportReason =
  | "spam"
  | "abuse"
  | "harassment"
  | "misinformation"
  | "other";

export const ANNOTATION_REPORT_LABELS: Record<AnnotationReportReason, string> = {
  spam: "广告或刷屏",
  abuse: "辱骂或攻击",
  harassment: "骚扰",
  misinformation: "明显错误信息",
  other: "其他",
};
