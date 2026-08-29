import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addAnnotationComment,
  createAnnotation,
  loadAnnotationThreads,
  reportAnnotationComment,
} from "./api";
import type {
  AnnotationReportReason,
  AnnotationSubject,
  AnnotationThread,
  AnnotationVisibility,
  TextAnchor,
} from "./types";

function compatibleThread(
  thread: AnnotationThread,
  currentUserId: string | null | undefined,
  assumeCurrentReader = false,
): AnnotationThread | undefined {
  const hasAggregateFields = Number.isFinite(thread.underlineCount)
    && typeof thread.underlinedByMe === "boolean"
    && typeof thread.publiclyVisible === "boolean";
  const underlinedByMe = hasAggregateFields
    ? Boolean(thread.underlinedByMe)
    : assumeCurrentReader || Boolean(currentUserId && thread.authorId === currentUserId);
  // Before the aggregation migration, the RPC returned every reader's marks.
  // Fail closed so a legacy database only exposes the current reader's marks.
  if (!hasAggregateFields && !underlinedByMe) return undefined;
  return {
    ...thread,
    underlineCount: Math.max(1, Math.trunc(thread.underlineCount ?? 1)),
    underlinedByMe,
    publiclyVisible: hasAggregateFields ? Boolean(thread.publiclyVisible) : false,
  };
}

export function useAnnotationThreads(subject: AnnotationSubject, enabled: boolean, currentUserId?: string | null) {
  const [threads, setThreads] = useState<AnnotationThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const subjectKey = `${subject.contentType}:${subject.contentId}:${subject.sectionId}`;
  const stableSubject = useMemo<AnnotationSubject>(() => ({
    contentType: subject.contentType,
    contentId: subject.contentId,
    sectionId: subject.sectionId,
    contentTitle: subject.contentTitle,
    contentUrl: subject.contentUrl,
  }), [subject.contentId, subject.contentTitle, subject.contentType, subject.contentUrl, subject.sectionId]);
  const activeSubjectKey = useRef(subjectKey);
  const displayedSubjectKey = useRef(subjectKey);
  const requestId = useRef(0);
  activeSubjectKey.current = subjectKey;

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    if (!enabled) {
      setThreads([]);
      setError("");
      setLoading(false);
      return;
    }
    if (displayedSubjectKey.current !== subjectKey) {
      displayedSubjectKey.current = subjectKey;
      setThreads([]);
    }
    setLoading(true);
    setError("");
    try {
      const loaded = await loadAnnotationThreads(stableSubject);
      if (requestId.current === currentRequest) {
        const compatible = loaded.flatMap((thread) => {
          const normalized = compatibleThread(thread, currentUserId);
          return normalized ? [normalized] : [];
        });
        setThreads((current) => current.length === 0 && compatible.length === 0 ? current : compatible);
      }
    } catch (reason) {
      if (requestId.current === currentRequest) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setThreads([]);
      }
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [currentUserId, enabled, stableSubject, subjectKey]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  const actions = useMemo(() => ({
    async create(anchor: TextAnchor, initialComment?: string, visibility: AnnotationVisibility = "public") {
      const actionSubjectKey = subjectKey;
      const created = await createAnnotation(stableSubject, anchor, initialComment, visibility);
      const compatible = compatibleThread(created, currentUserId, true)!;
      if (activeSubjectKey.current === actionSubjectKey) {
        setThreads((current) => current.some((thread) => thread.id === compatible.id)
          ? current.map((thread) => thread.id === compatible.id ? compatible : thread)
          : [...current, compatible]);
      }
      return compatible;
    },
    async comment(annotationId: string, body: string, parentCommentId?: string, visibility: AnnotationVisibility = "public") {
      const actionSubjectKey = subjectKey;
      const created = await addAnnotationComment(annotationId, body, parentCommentId, visibility);
      if (activeSubjectKey.current === actionSubjectKey) {
        setThreads((current) => current.map((thread) => thread.id === annotationId
          ? { ...thread, comments: [...thread.comments, created] }
          : thread));
      }
      return created;
    },
    async report(annotationId: string, commentId: string, reason: AnnotationReportReason, details?: string) {
      const actionSubjectKey = subjectKey;
      await reportAnnotationComment(commentId, reason, details);
      if (activeSubjectKey.current === actionSubjectKey) {
        setThreads((current) => current.map((thread) => thread.id === annotationId
          ? { ...thread, comments: thread.comments.map((comment) => comment.id === commentId ? { ...comment, reportedByMe: true } : comment) }
          : thread));
      }
    },
  }), [currentUserId, stableSubject, subjectKey]);

  return { threads, loading, error, refresh, ...actions };
}
