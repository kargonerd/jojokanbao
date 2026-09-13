import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addAnnotationComment,
  createAnnotation,
  deleteMyAnnotationMark,
  deleteMyAnnotationComment,
  loadAnnotationThreads,
  reportAnnotationComment,
  setAnnotationCommentLike,
} from "./api";
import { sortAnnotationComments } from "./types";
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
    comments: sortAnnotationComments(thread.comments),
    underlineCount: Math.max(0, Math.trunc(thread.underlineCount ?? 1)),
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
  const threadsRef = useRef(state.threads);
  threadsRef.current = state.threads;
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
      if (!isCurrent()) return;
      // A read that started before a successful mutation must not restore stale data.
      requestId.current += 1;
      setState((current) => {
        if (!isCurrent()) return current;
        const previous = current.context === context ? current : { context, threads: [], loading: false, error: "" };
        const nextThreads = update(previous.threads);
        threadsRef.current = nextThreads;
        return { ...previous, threads: nextThreads, loading: false, error: "" };
      });
    };
    return {
      async create(anchor: TextAnchor, initialComment?: string, visibility: AnnotationVisibility = "public") {
        const expectedUserId = requireCurrentUser();
        let optimisticId: string | undefined;
        let matchedExisting = false;
        let previousThread: AnnotationThread | undefined;

        if (!initialComment) {
          optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const existing = threadsRef.current.find((t) => t.sectionId === stableSubject.sectionId
            && t.quote === anchor.quote
            && t.startOffset === anchor.startOffset
            && t.endOffset === anchor.endOffset);
          if (existing) {
            matchedExisting = true;
            previousThread = existing;
          }

          updateThreads((threads) => {
            const existingIndex = threads.findIndex((t) => t.sectionId === stableSubject.sectionId
              && t.quote === anchor.quote
              && t.startOffset === anchor.startOffset
              && t.endOffset === anchor.endOffset);
            if (existingIndex !== -1) {
              return threads.map((t, idx) => idx === existingIndex
                ? { ...t, underlinedByMe: true, underlineCount: (t.underlineCount ?? 0) + (t.underlinedByMe ? 0 : 1) }
                : t);
            }
            const optimisticThread: AnnotationThread = {
              ...stableSubject,
              ...anchor,
              id: optimisticId!,
              authorId: expectedUserId,
              authorName: "",
              createdAt: new Date().toISOString(),
              underlineCount: 1,
              underlinedByMe: true,
              publiclyVisible: visibility === "public",
              comments: [],
            };
            return [...threads, optimisticThread];
          });
        }

        try {
          const created = await createAnnotation(stableSubject, anchor, initialComment, visibility, expectedUserId);
          requireCurrentUser();
          const compatible = compatibleThread(created, currentUserId, true)!;
          updateThreads((threads) => {
            const withoutOptimistic = optimisticId ? threads.filter((t) => t.id !== optimisticId) : threads;
            return withoutOptimistic.some((thread) => thread.id === compatible.id)
              ? withoutOptimistic.map((thread) => thread.id === compatible.id ? compatible : thread)
              : [...withoutOptimistic, compatible];
          });
          return compatible;
        } catch (error) {
          if (isCurrent() && optimisticId) {
            updateThreads((threads) => {
              if (matchedExisting && previousThread) {
                return threads.map((t) => t.id === previousThread!.id ? previousThread! : t);
              }
              return threads.filter((t) => t.id !== optimisticId);
            });
          }
          throw error;
        }
      },
      async comment(annotationId: string, body: string, parentCommentId?: string, visibility: AnnotationVisibility = "public") {
        const expectedUserId = requireCurrentUser();
        const created = await addAnnotationComment(annotationId, body, parentCommentId, visibility, expectedUserId);
        requireCurrentUser();
        updateThreads((threads) => threads.map((thread) => thread.id === annotationId
          ? { ...thread, comments: sortAnnotationComments([...thread.comments, created]) }
          : thread));
        return created;
      },
      async removeMark(annotationId: string) {
        const expectedUserId = requireCurrentUser();
        const changed = await deleteMyAnnotationMark(annotationId, expectedUserId);
        requireCurrentUser();
        const normalized = changed ? compatibleThread(changed, currentUserId) : undefined;
        updateThreads((threads) => threads.flatMap((thread) => thread.id === annotationId
          ? normalized ? [normalized] : []
          : [thread]));
        return changed;
      },
      async deleteComment(commentId: string) {
        const expectedUserId = requireCurrentUser();
        const changed = await deleteMyAnnotationComment(commentId, expectedUserId);
        requireCurrentUser();
        const normalized = changed.thread ? compatibleThread(changed.thread, currentUserId) : undefined;
        updateThreads((threads) => threads.flatMap((thread) => {
          if (changed.annotationId ? thread.id === changed.annotationId : thread.comments.some((c) => c.id === commentId)) {
            if (normalized) return [normalized];
            if (changed.annotationId && changed.thread === null) return [];
            const remaining = thread.comments.filter((c) => c.id !== commentId);
            if (thread.underlinedByMe || remaining.length > 0) {
              return [{ ...thread, comments: remaining }];
            }
            return [];
          }
          return [thread];
        }));
        return changed;
      },
      async like(annotationId: string, commentId: string, liked: boolean) {
        const expectedUserId = requireCurrentUser();
        const currentThread = threadsRef.current.find((t) => t.id === annotationId);
        const previousComment = currentThread?.comments.find((c) => c.id === commentId);

        updateThreads((threads) => threads.map((thread) => {
          if (thread.id !== annotationId) return thread;
          return {
            ...thread,
            comments: sortAnnotationComments(thread.comments.map((comment) => {
              if (comment.id !== commentId) return comment;
              const delta = liked ? 1 : -1;
              const currentCount = comment.likeCount ?? 0;
              return {
                ...comment,
                likedByMe: liked,
                likeCount: Math.max(0, currentCount + delta),
              };
            })),
          };
        }));

        try {
          const changed = await setAnnotationCommentLike(commentId, liked, expectedUserId);
          requireCurrentUser();
          updateThreads((threads) => threads.map((thread) => thread.id === annotationId
            ? { ...thread, comments: sortAnnotationComments(thread.comments.map((comment) => comment.id === commentId
              ? { ...comment, likeCount: changed.likeCount, likedByMe: changed.likedByMe }
              : comment)) }
            : thread));
          return changed;
        } catch (error) {
          if (isCurrent() && previousComment) {
            updateThreads((threads) => threads.map((thread) => thread.id === annotationId
              ? {
                ...thread,
                comments: sortAnnotationComments(thread.comments.map((comment) => comment.id === commentId
                  ? previousComment
                  : comment)),
              }
              : thread));
          }
          throw error;
        }
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
