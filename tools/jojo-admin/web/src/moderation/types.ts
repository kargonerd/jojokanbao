export type ModerationStatus = "pending" | "resolved" | "dismissed" | "all";
export type ModerationAction = "hide" | "restore" | "dismiss";

export interface CommentReport {
  id: string;
  reason: string;
  details?: string | null;
  status: Exclude<ModerationStatus, "all">;
  reporterName: string;
  createdAt: string;
}

export interface ModerationItem {
  commentId: string;
  annotationId: string;
  commentBody: string;
  commentStatus: "visible" | "hidden";
  commentAuthorName: string;
  commentCreatedAt: string;
  quote: string;
  contentType: string;
  contentId: string;
  sectionId: string;
  contentTitle: string;
  contentUrl?: string | null;
  reportCount: number;
  reports: CommentReport[];
}
