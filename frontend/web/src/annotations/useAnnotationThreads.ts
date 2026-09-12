import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

const EMPTY_THREADS: AnnotationThread[] = [];

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
  const subjectKey = JSON.stringify([subject.contentType, subject.contentId, subject.sectionId, currentUserId ?? null]);
  const canAccess = enabled && Boolean(currentUserId);
  const context = useMemo(() => ({ subjectKey, canAccess }), [subjectKey, canAccess]);
  const [state, setState] = useState({ context, threads: [] as AnnotationThread[], loading: false, error: "" });
  const stableSubject = useMemo<AnnotationSubject>(() => ({
    contentType: subject.contentType,
    contentId: subject.contentId,
    sectionId: subject.sectionId,
    contentTitle: subject.contentTitle,
    contentUrl: subject.contentUrl,
  }), [subject.contentId, subject.contentTitle, subject.contentType, subject.contentUrl, subject.sectionId]);
  const activeContext = useRef(context);
  const mounted = useRef(false);
  const requestId = useRef(0);
  activeContext.current = context;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const isCurrent = useCallback(() => mounted.current && activeContext.current === context, [context]);

  const refresh = useCallback(async () => {
    if (!isCurrent()) return;
    const currentRequest = ++requestId.current;
    if (!canAccess || !currentUserId) {
      setState({ context, threads: [], loading: false, error: "" });
      return;
    }
    setState((current) => ({ context, threads: current.context === context ? current.threads : [], loading: true, error: "" }));
    try {
      const loaded = await loadAnnotationThreads(stableSubject, currentUserId);
      if (isCurrent() && requestId.current === currentRequest) {
        const compatible = loaded.flatMap((thread) => {
          const normalized = compatibleThread(thread, currentUserId);
          return normalized ? [normalized] : [];
        });
        setState({ context, threads: compatible, loading: false, error: "" });
      }
    } catch (reason) {
      if (isCurrent() && requestId.current === currentRequest) {
        setState({ context, threads: [], loading: false, error: reason instanceof Error ? reason.message : String(reason) });
      }
    }
  }, [canAccess, context, currentUserId, isCurrent, stableSubject]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  const actions = useMemo(() => {
    const requireCurrentUser = () => {
      if (!canAccess || !currentUserId || !isCurrent()) throw new Error("登录状态已变化，请重新打开笔记");
      return currentUserId;
    };
    const updateThreads = (update: (threads: AnnotationThread[]) => AnnotationThread[]) => {
      setState((current) => {
        if (!isCurrent()) return current;
        const previous = current.context === context ? current : { context, threads: [], loading: false, error: "" };
        return { ...previous, threads: update(previous.threads) };
      });
    };
    return {
      async create(anchor: TextAnchor, initialComment?: string, visibility: AnnotationVisibility = "public") {
        const expectedUserId = requireCurrentUser();
        const created = await createAnnotation(stableSubject, anchor, initialComment, visibility, expectedUserId);
        requireCurrentUser();
        const compatible = compatibleThread(created, currentUserId, true)!;
        updateThreads((threads) => threads.some((thread) => thread.id === compatible.id)
          ? threads.map((thread) => thread.id === compatible.id ? compatible : thread)
          : [...threads, compatible]);
        return compatible;
      },
      async comment(annotationId: string, body: string, parentCommentId?: string, visibility: AnnotationVisibility = "public") {
        const expectedUserId = requireCurrentUser();
        const created = await addAnnotationComment(annotationId, body, parentCommentId, visibility, expectedUserId);
        requireCurrentUser();
        updateThreads((threads) => threads.map((thread) => thread.id === annotationId
          ? { ...thread, comments: [...thread.comments, created] }
          : thread));
        return created;
      },
      async report(annotationId: string, commentId: string, reason: AnnotationReportReason, details?: string) {
        const expectedUserId = requireCurrentUser();
        await reportAnnotationComment(commentId, reason, details, expectedUserId);
        requireCurrentUser();
        updateThreads((threads) => threads.map((thread) => thread.id === annotationId
          ? { ...thread, comments: thread.comments.map((comment) => comment.id === commentId ? { ...comment, reportedByMe: true } : comment) }
          : thread));
      },
    };
  }, [canAccess, context, currentUserId, isCurrent, stableSubject]);

  const visible = canAccess && state.context === context;
  return { threads: visible ? state.threads : EMPTY_THREADS, loading: visible && state.loading, error: visible ? state.error : "", refresh, ...actions };
}
