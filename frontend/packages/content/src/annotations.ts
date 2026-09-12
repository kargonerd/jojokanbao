import type {
  AnnotationComment,
  AnnotationCommentLike,
  AnnotationReportReason,
  AnnotationSubject,
  AnnotationThread,
  AnnotationVisibility,
  TextAnchor,
} from "./annotation-types";
export * from "./annotation-types";

export interface AnnotationApiDependencies {
  /** Bind transport credentials to this reader; never borrow a newer live session. */
  rpc: (name: string, params: Record<string, unknown>, expectedUserId: string) => PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
  getCurrentUserId: () => Promise<string | null>;
  currentPath?: () => string;
}

export interface BookAnnotationProgress {
  notes: AnnotationThread[];
  loadedSections: number;
  totalSections: number;
}

export interface BookAnnotationOptions {
  onProgress?: (progress: BookAnnotationProgress) => void;
  signal?: AbortSignal;
  /** Synchronize changes from other devices; local writes invalidate their chapter. */
  refresh?: boolean;
}

interface BookAnnotationCache {
  contentId: string;
  chapters: Map<string, { request: Promise<AnnotationThread[]>; expiresAt: number }>;
  annotationSections: Map<string, string>;
  commentSections: Map<string, string>;
}

function subjectParams(subject: AnnotationSubject) {
  return {
    p_content_type: subject.contentType,
    p_content_id: subject.contentId,
    p_section_id: subject.sectionId,
  };
}

function resultOrThrow<T>(data: unknown, error: { message?: string } | null): T {
  if (error) throw new Error(error.message || "划线评论服务暂时不可用");
  if (data === null) throw new Error("划线评论服务返回了空结果");
  return data as T;
}

function checkAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("请求已取消");
  error.name = "AbortError";
  throw signal.reason ?? error;
}

/** Same deployed annotation RPCs for browser and native readers, with no UI/runtime dependency. */
export function createAnnotationApi({ rpc, getCurrentUserId, currentPath = () => "/" }: AnnotationApiDependencies) {
  async function requireSameReader(currentUserId: string) {
    if (await getCurrentUserId() !== currentUserId) throw new Error("登录状态已变化，请重新打开笔记");
  }

  async function forCurrentReader<T>(operation: (userId: string) => Promise<T>, expectedUserId?: string): Promise<T> {
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) throw new Error("请先登录后使用阅读笔记");
    if (expectedUserId !== undefined && currentUserId !== expectedUserId) throw new Error("登录状态已变化，请重新打开笔记");
    const result = await operation(currentUserId);
    await requireSameReader(currentUserId);
    return result;
  }

  async function loadAnnotationThreads(subject: AnnotationSubject, expectedUserId?: string): Promise<AnnotationThread[]> {
    return forCurrentReader(async (userId) => {
      const { data, error } = await rpc("get_annotation_threads", subjectParams(subject), userId);
      const result = resultOrThrow<unknown>(data, error);
      return Array.isArray(result) ? result as AnnotationThread[] : [];
    }, expectedUserId);
  }

  // Session-only, separated by reader. Reopening a tool reuses loaded chapters.
  const bookAnnotationCaches = new Map<string, BookAnnotationCache>();

  function invalidateBookAnnotationChapter(contentId: string, sectionId: string) {
    for (const cache of bookAnnotationCaches.values()) {
      if (cache.contentId === contentId) cache.chapters.delete(sectionId);
    }
  }

  function invalidateBookAnnotationComment(annotationId: string) {
    for (const cache of bookAnnotationCaches.values()) {
      const sectionId = cache.annotationSections.get(annotationId);
      if (sectionId) cache.chapters.delete(sectionId);
    }
  }

  function invalidateBookAnnotationLike(commentId: string) {
    for (const cache of bookAnnotationCaches.values()) {
      const sectionId = cache.commentSections.get(commentId);
      if (sectionId) cache.chapters.delete(sectionId);
    }
  }

  function personalBookNotes(threads: AnnotationThread[], currentUserId: string): AnnotationThread[] {
    return threads.flatMap((thread) => {
      const comments = thread.comments.filter((comment) => comment.authorId === currentUserId);
      // Older deployments identify an underline by its original author.
      const underlinedByMe = thread.underlinedByMe ?? thread.authorId === currentUserId;
      return underlinedByMe || comments.length > 0 ? [{ ...thread, underlinedByMe, comments }] : [];
    });
  }

  /** Reuse the deployed, chapter-scoped discussion API for this reader's notes. */
  async function loadMyBookAnnotations(
    contentId: string,
    sectionIds: readonly string[],
    currentUserId: string | null,
    options: BookAnnotationOptions = {},
  ): Promise<AnnotationThread[]> {
    if (!currentUserId) return [];
    checkAborted(options.signal);
    await requireSameReader(currentUserId);
    const cacheKey = JSON.stringify([currentUserId, contentId]);
    if (options.refresh) bookAnnotationCaches.delete(cacheKey);
    let cache = bookAnnotationCaches.get(cacheKey);
    if (!cache) {
      cache = { contentId, chapters: new Map(), annotationSections: new Map(), commentSections: new Map() };
      // Bound retained books, while keeping every chapter of an open book reusable.
      if (bookAnnotationCaches.size >= 8) bookAnnotationCaches.delete(bookAnnotationCaches.keys().next().value!);
      bookAnnotationCaches.set(cacheKey, cache);
    }
    const bookCache = cache;
    const sections = [...new Set(sectionIds.filter(Boolean))];
    const notes = new Map<string, AnnotationThread>();
    // The deployed API is scoped to one chapter. Bound requests for long books.
    for (let start = 0; start < sections.length; start += 4) {
      checkAborted(options.signal);
      await requireSameReader(currentUserId);
      checkAborted(options.signal);
      const chapters = await Promise.all(sections.slice(start, start + 4).map((sectionId) => {
        const cached = bookCache.chapters.get(sectionId);
        if (cached && cached.expiresAt > Date.now()) return cached.request;
        let request!: Promise<AnnotationThread[]>;
        request = (async () => {
          const { data, error } = await rpc("get_annotation_threads", {
            p_content_type: "book",
            p_content_id: contentId,
            p_section_id: sectionId,
          }, currentUserId);
          const result = resultOrThrow<unknown>(data, error);
          await requireSameReader(currentUserId);
          const threads = Array.isArray(result) ? result as AnnotationThread[] : [];
          const entry = bookCache.chapters.get(sectionId);
          if (entry?.request === request) {
            entry.expiresAt = Date.now() + 60_000;
            for (const [annotationId, chapterId] of bookCache.annotationSections) {
              if (chapterId === sectionId) bookCache.annotationSections.delete(annotationId);
            }
            for (const [commentId, chapterId] of bookCache.commentSections) {
              if (chapterId === sectionId) bookCache.commentSections.delete(commentId);
            }
            for (const thread of threads) {
              bookCache.annotationSections.set(thread.id, sectionId);
              for (const comment of thread.comments) bookCache.commentSections.set(comment.id, sectionId);
            }
          }
          return personalBookNotes(threads, currentUserId);
        })();
        if (bookCache.chapters.size >= 2048 && !bookCache.chapters.has(sectionId)) {
          const oldestSection = bookCache.chapters.keys().next().value!;
          bookCache.chapters.delete(oldestSection);
          for (const [annotationId, chapterId] of bookCache.annotationSections) {
            if (chapterId === oldestSection) bookCache.annotationSections.delete(annotationId);
          }
          for (const [commentId, chapterId] of bookCache.commentSections) {
            if (chapterId === oldestSection) bookCache.commentSections.delete(commentId);
          }
        }
        bookCache.chapters.set(sectionId, { request, expiresAt: Number.POSITIVE_INFINITY });
        void request.catch(() => {
          if (bookCache.chapters.get(sectionId)?.request === request) bookCache.chapters.delete(sectionId);
        });
        return request;
      }));
      checkAborted(options.signal);
      await requireSameReader(currentUserId);
      checkAborted(options.signal);
      for (const threads of chapters) {
        for (const thread of threads) notes.set(thread.id, thread);
      }
      options.onProgress?.({ notes: [...notes.values()], loadedSections: Math.min(start + 4, sections.length), totalSections: sections.length });
    }
    return [...notes.values()];
  }

  async function createAnnotation(
    subject: AnnotationSubject,
    anchor: TextAnchor,
    initialComment?: string,
    initialCommentVisibility: AnnotationVisibility = "public",
    expectedUserId?: string,
  ): Promise<AnnotationThread> {
    return forCurrentReader(async (userId) => {
      const { data, error } = await rpc("create_content_annotation", {
        ...subjectParams(subject),
        p_content_title: subject.contentTitle,
        p_content_url: subject.contentUrl || currentPath(),
        p_quote: anchor.quote,
        p_prefix: anchor.prefix,
        p_suffix: anchor.suffix,
        p_start_offset: anchor.startOffset,
        p_end_offset: anchor.endOffset,
        p_initial_comment: initialComment?.trim() || null,
        // Public is also the database default. Omitting it keeps underline-only and
        // public-comment writes compatible while the visibility migration rolls out.
        ...(initialCommentVisibility === "private"
          ? { p_initial_comment_visibility: initialCommentVisibility }
          : {}),
      }, userId);
      const result = resultOrThrow<AnnotationThread>(data, error);
      if (subject.contentType === "book") invalidateBookAnnotationChapter(subject.contentId, subject.sectionId);
      return result;
    }, expectedUserId);
  }

  async function addAnnotationComment(
    annotationId: string,
    body: string,
    parentCommentId?: string,
    visibility: AnnotationVisibility = "public",
    expectedUserId?: string,
  ): Promise<AnnotationComment> {
    return forCurrentReader(async (userId) => {
      const { data, error } = await rpc("add_annotation_comment", {
        p_annotation_id: annotationId,
        p_body: body.trim(),
        p_parent_comment_id: parentCommentId || null,
        ...(visibility === "private" ? { p_visibility: visibility } : {}),
      }, userId);
      const result = resultOrThrow<AnnotationComment>(data, error);
      invalidateBookAnnotationComment(annotationId);
      return result;
    }, expectedUserId);
  }

  async function reportAnnotationComment(
    commentId: string,
    reason: AnnotationReportReason,
    details?: string,
    expectedUserId?: string,
  ): Promise<void> {
    return forCurrentReader(async (userId) => {
      const { error } = await rpc("report_annotation_comment", {
        p_comment_id: commentId,
        p_reason: reason,
        p_details: details?.trim() || null,
      }, userId);
      if (error) throw new Error(error.message || "举报提交失败");
    }, expectedUserId);
  }

  async function setAnnotationCommentLike(commentId: string, liked: boolean, expectedUserId?: string): Promise<AnnotationCommentLike> {
    return forCurrentReader(async (userId) => {
      const { data, error } = await rpc("set_annotation_comment_like", { p_comment_id: commentId, p_liked: liked }, userId);
      const result = resultOrThrow<AnnotationCommentLike>(data, error);
      invalidateBookAnnotationLike(commentId);
      return result;
    }, expectedUserId);
  }

  async function deleteMyAnnotationMark(annotationId: string, expectedUserId?: string): Promise<AnnotationThread | null> {
    return forCurrentReader(async (userId) => {
      const { data, error } = await rpc("delete_my_annotation_mark", { p_annotation_id: annotationId }, userId);
      const result = resultOrThrow<{ thread: AnnotationThread | null }>(data, error);
      invalidateBookAnnotationComment(annotationId);
      return result.thread;
    }, expectedUserId);
  }

  return { loadAnnotationThreads, loadMyBookAnnotations, createAnnotation, addAnnotationComment, reportAnnotationComment, setAnnotationCommentLike, deleteMyAnnotationMark };
}
