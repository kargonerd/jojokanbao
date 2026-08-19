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
  TextAnchor,
} from "./types";

export function useAnnotationThreads(subject: AnnotationSubject, enabled: boolean) {
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
        setThreads((current) => current.length === 0 && loaded.length === 0 ? current : loaded);
      }
    } catch (reason) {
      if (requestId.current === currentRequest) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setThreads([]);
      }
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [enabled, stableSubject, subjectKey]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  const actions = useMemo(() => ({
    async create(anchor: TextAnchor, initialComment?: string) {
      const actionSubjectKey = subjectKey;
      const created = await createAnnotation(stableSubject, anchor, initialComment);
      if (activeSubjectKey.current === actionSubjectKey) {
        setThreads((current) => current.some((thread) => thread.id === created.id)
          ? current.map((thread) => thread.id === created.id ? created : thread)
          : [...current, created]);
      }
      return created;
    },
    async comment(annotationId: string, body: string, parentCommentId?: string) {
      const actionSubjectKey = subjectKey;
      const created = await addAnnotationComment(annotationId, body, parentCommentId);
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
  }), [stableSubject, subjectKey]);

  return { threads, loading, error, refresh, ...actions };
}
