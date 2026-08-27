import type {
  AnnotationComment,
  AnnotationReportReason,
  AnnotationSubject,
  AnnotationThread,
  AnnotationVisibility,
  TextAnchor,
} from "./types";

// Annotation RPCs are introduced by the matching Supabase migration. Load the
// configured client only when an authenticated feature actually calls an RPC;
// public content rendering and tests must remain independent of account config.
async function rpc(name: string, params: Record<string, unknown>) {
  const { authClient } = await import("../account/auth");
  // Keep the generated database type stable until the migration ships everywhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (authClient as any).rpc(name, params);
}

function currentLocalPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function subjectParams(subject: AnnotationSubject) {
  return {
    p_content_type: subject.contentType,
    p_content_id: subject.contentId,
    p_section_id: subject.sectionId,
  };
}

function resultOrThrow<T>(data: T | null, error: { message?: string } | null): T {
  if (error) throw new Error(error.message || "划线评论服务暂时不可用");
  if (data === null) throw new Error("划线评论服务返回了空结果");
  return data;
}

export async function loadAnnotationThreads(subject: AnnotationSubject): Promise<AnnotationThread[]> {
  const { data, error } = await rpc("get_annotation_threads", subjectParams(subject));
  const result = resultOrThrow<unknown>(data, error);
  return Array.isArray(result) ? result as AnnotationThread[] : [];
}

export async function createAnnotation(
  subject: AnnotationSubject,
  anchor: TextAnchor,
  initialComment?: string,
  initialCommentVisibility: AnnotationVisibility = "public",
): Promise<AnnotationThread> {
  const { data, error } = await rpc("create_content_annotation", {
    ...subjectParams(subject),
    p_content_title: subject.contentTitle,
    p_content_url: subject.contentUrl || currentLocalPath(),
    p_quote: anchor.quote,
    p_prefix: anchor.prefix,
    p_suffix: anchor.suffix,
    p_start_offset: anchor.startOffset,
    p_end_offset: anchor.endOffset,
    p_initial_comment: initialComment?.trim() || null,
    p_initial_comment_visibility: initialCommentVisibility,
  });
  return resultOrThrow<AnnotationThread>(data, error);
}

export async function addAnnotationComment(
  annotationId: string,
  body: string,
  parentCommentId?: string,
  visibility: AnnotationVisibility = "public",
): Promise<AnnotationComment> {
  const { data, error } = await rpc("add_annotation_comment", {
    p_annotation_id: annotationId,
    p_body: body.trim(),
    p_parent_comment_id: parentCommentId || null,
    p_visibility: visibility,
  });
  return resultOrThrow<AnnotationComment>(data, error);
}

export async function reportAnnotationComment(
  commentId: string,
  reason: AnnotationReportReason,
  details?: string,
): Promise<void> {
  const { error } = await rpc("report_annotation_comment", {
    p_comment_id: commentId,
    p_reason: reason,
    p_details: details?.trim() || null,
  });
  if (error) throw new Error(error.message || "举报提交失败");
}
