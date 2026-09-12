import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationReportReason, AnnotationSubject, AnnotationThread, AnnotationVisibility, TextAnchor } from "@jojo/content/annotations";
import { addAnnotationComment, createAnnotation, loadAnnotationThreads, loadMyBookAnnotations, reportAnnotationComment } from "./api";

interface Options {
  userId: string | null;
  contentId: string;
  sectionIds: readonly string[];
  activeSectionId: string;
  loadAll: boolean;
}
interface Snapshot {
  key: string;
  sections: Record<string, AnnotationThread[]>;
  personal: AnnotationThread[];
  loading: boolean;
  error: string;
}

export function annotationError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  if (/登录|账号|account|sign.?in|session/i.test(message)) return "登录状态已变化，请重新登录后重试";
  if (/not enabled|not allowed|permission|privilege/i.test(message)) return "暂时无法使用想法功能，请稍后重试";
  return "想法暂时无法保存或读取，请重试";
}

/** Cloud discussions stay in memory and are never reused across accounts. */
export function useBookAnnotations({ userId, contentId, sectionIds, activeSectionId, loadAll }: Options) {
  const key = JSON.stringify([userId, contentId]);
  const current = useRef(key);
  current.current = key;
  const writeVersion = useRef(0);
  const [revision, setRevision] = useState(0);
  const [writeRevision, setWriteRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>({ key, sections: {}, personal: [], loading: false, error: "" });
  const sectionKey = JSON.stringify(sectionIds);
  const update = useCallback((change: (value: Snapshot) => Snapshot) => {
    if (current.current !== key) return;
    setSnapshot((value) => change(value.key === key ? value : { key, sections: {}, personal: [], loading: false, error: "" }));
  }, [key]);
  useEffect(() => { current.current = key; return () => { if (current.current === key) current.current = ""; }; }, [key]);

  useEffect(() => {
    if (!userId || !activeSectionId) return;
    let active = true;
    const version = writeVersion.current;
    void loadAnnotationThreads({ contentType: "book", contentId, sectionId: activeSectionId, contentTitle: "" }, userId)
      .then((threads) => { if (active && version === writeVersion.current) update((value) => ({ ...value, sections: { ...value.sections, [activeSectionId]: threads } })); })
      .catch((reason) => { if (active && version === writeVersion.current) update((value) => ({ ...value, error: annotationError(reason) })); });
    return () => { active = false; };
  }, [key, userId, contentId, activeSectionId, revision, update]);

  useEffect(() => {
    if (!userId || !loadAll) return;
    const controller = new AbortController();
    const version = writeVersion.current;
    const receivePersonal = (notes: AnnotationThread[]) => {
      if (controller.signal.aborted || version !== writeVersion.current) return;
      update((value) => {
        const fresh = new Map(notes.map((thread) => [thread.id, thread]));
        const sections = Object.fromEntries(Object.entries(value.sections).map(([sectionId, threads]) => [sectionId, threads.map((thread) => {
          const personal = fresh.get(thread.id);
          if (!personal) return thread;
          const own = new Map(personal.comments.filter((comment) => comment.authorId === userId).map((comment) => [comment.id, comment]));
          const comments = thread.comments.flatMap((comment) => {
            if (comment.authorId !== userId) return [comment];
            const refreshed = own.get(comment.id);
            own.delete(comment.id);
            return refreshed ? [refreshed] : [];
          });
          return { ...thread, underlinedByMe: personal.underlinedByMe, comments: [...comments, ...own.values()] };
        })]));
        return { ...value, personal: notes, sections };
      });
    };
    update((value) => ({ ...value, loading: true, error: "" }));
    void loadMyBookAnnotations(contentId, JSON.parse(sectionKey) as string[], userId, {
      signal: controller.signal,
      refresh: revision > 0,
      onProgress: ({ notes }) => receivePersonal(notes),
    }).then(receivePersonal)
      .catch((reason) => { if (!controller.signal.aborted && version === writeVersion.current) update((value) => ({ ...value, error: annotationError(reason) })); })
      .finally(() => { if (!controller.signal.aborted) update((value) => ({ ...value, loading: false })); });
    return () => controller.abort();
  }, [key, userId, contentId, sectionKey, loadAll, revision, writeRevision, update]);

  const upsert = useCallback((thread: AnnotationThread) => {
    update((value) => ({ ...value, sections: {
      ...value.sections,
      [thread.sectionId]: [...(value.sections[thread.sectionId] ?? []).filter((entry) => entry.id !== thread.id), thread],
    } }));
  }, [update]);
  const ensureCurrent = () => { if (!userId || current.current !== key) throw new Error("登录状态已变化，请重试"); };
  const threads = useMemo(() => {
    if (!userId || snapshot.key !== key) return [];
    const map = new Map(snapshot.personal.map((thread) => [thread.id, thread]));
    Object.values(snapshot.sections).flat().forEach((thread) => map.set(thread.id, thread));
    return [...map.values()];
  }, [snapshot, key, userId]);
  const notes = useMemo(() => threads.flatMap((thread) => {
    const comments = thread.comments.filter((comment) => comment.authorId === userId);
    const underlinedByMe = thread.underlinedByMe ?? thread.authorId === userId;
    return underlinedByMe || comments.length ? [{ ...thread, comments, underlinedByMe }] : [];
  }), [threads, userId]);

  return {
    threads, notes,
    loading: snapshot.key === key && snapshot.loading,
    error: snapshot.key === key ? snapshot.error : "",
    refresh: () => { update((value) => ({ ...value, error: "" })); setRevision((value) => value + 1); },
    async create(subject: AnnotationSubject, anchor: TextAnchor, body?: string, visibility: AnnotationVisibility = "public") {
      ensureCurrent();
      const saved = await createAnnotation(subject, anchor, body, visibility, userId!);
      ensureCurrent(); writeVersion.current += 1;
      upsert({ ...saved, underlinedByMe: true });
      setWriteRevision((value) => value + 1);
      return saved;
    },
    async open(thread: AnnotationThread) {
      ensureCurrent();
      const version = writeVersion.current;
      const loaded = await loadAnnotationThreads(thread, userId!);
      ensureCurrent();
      if (version === writeVersion.current) update((value) => ({ ...value, sections: { ...value.sections, [thread.sectionId]: loaded } }));
    },
    async comment(thread: AnnotationThread, body: string, parentCommentId?: string, visibility: AnnotationVisibility = "public") {
      ensureCurrent();
      const saved = await addAnnotationComment(thread.id, body, parentCommentId, visibility, userId!);
      ensureCurrent(); writeVersion.current += 1;
      update((value) => ({ ...value, sections: {
        ...value.sections,
        [thread.sectionId]: [...(value.sections[thread.sectionId] ?? []).filter((entry) => entry.id !== thread.id), {
          ...(value.sections[thread.sectionId]?.find((entry) => entry.id === thread.id) ?? thread),
          comments: [...(value.sections[thread.sectionId]?.find((entry) => entry.id === thread.id)?.comments ?? thread.comments).filter((comment) => comment.id !== saved.id), saved],
        }],
      } }));
      setWriteRevision((value) => value + 1);
      return saved;
    },
    async report(thread: AnnotationThread, commentId: string, reason: AnnotationReportReason, details?: string) {
      ensureCurrent();
      await reportAnnotationComment(commentId, reason, details, userId!);
      ensureCurrent(); writeVersion.current += 1;
      update((value) => {
        const entries = value.sections[thread.sectionId] ?? [];
        const latest = entries.find((entry) => entry.id === thread.id) ?? thread;
        return { ...value, sections: { ...value.sections, [thread.sectionId]: [
          ...entries.filter((entry) => entry.id !== thread.id),
          { ...latest, comments: latest.comments.map((comment) => comment.id === commentId ? { ...comment, reportedByMe: true } : comment) },
        ] } };
      });
    },
  };
}
