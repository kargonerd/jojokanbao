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
  rpc: (name: string, params: Record<string, unknown>, expectedUserId: string, signal?: AbortSignal) => PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
  getCurrentUserId: () => Promise<string | null>;
  currentPath?: () => string;
}

export interface BookAnnotationProgress {
  notes: AnnotationThread[];
  complete: boolean;
}

export interface BookAnnotationOptions {
  onProgress?: (progress: BookAnnotationProgress) => void;
  signal?: AbortSignal;
  /** Synchronize changes from other devices; local writes invalidate their book. */
  refresh?: boolean;
}

export interface PublicBookAnnotationOptions {
  signal?: AbortSignal;
  afterId?: string | null;
  refresh?: boolean;
}

export interface PublicBookAnnotationPage {
  notes: AnnotationThread[];
  nextCursor: string | null;
}

interface BookAnnotationCache {
  contentId: string;
  notes?: AnnotationThread[];
  expiresAt: number;
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

  // Cache only completed reads, separated by reader and book. Pending requests
  // belong to their caller, so closing a tool can actually cancel its transport.
  const bookAnnotationCaches = new Map<string, BookAnnotationCache>();

  function invalidateBookAnnotations(contentId: string) {
    for (const [key, cache] of bookAnnotationCaches) {
      if (cache.contentId === contentId) bookAnnotationCaches.delete(key);
    }
  }

  function invalidateBookAnnotationComment(annotationId: string) {
    // A first thought on another reader's underline is absent from personal
    // caches, so its book cannot be inferred from a cached personal thread.
    if (![...bookAnnotationCaches.values()].some((cache) => cache.notes?.some((thread) => thread.id === annotationId))) {
      bookAnnotationCaches.clear();
      return;
    }
    for (const [key, cache] of bookAnnotationCaches) {
      if (!cache.notes || cache.notes.some((thread) => thread.id === annotationId)) bookAnnotationCaches.delete(key);
    }
  }

  function invalidateBookAnnotationLike(commentId: string) {
    for (const [key, cache] of bookAnnotationCaches) {
      if (!cache.notes || cache.notes.some((thread) => thread.comments.some((comment) => comment.id === commentId))) bookAnnotationCaches.delete(key);
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

  /** Query only this reader's notes across the book, paging by annotation ID. */
  async function loadMyBookAnnotations(
    contentId: string,
    currentUserId: string | null,
    options: BookAnnotationOptions = {},
  ): Promise<AnnotationThread[]> {
    if (!currentUserId) return [];
    checkAborted(options.signal);
    const controller = new AbortController();
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const abort = () => {
      const error = new Error("笔记读取已取消");
      error.name = "AbortError";
      rejectCancelled(error);
      controller.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      rejectCancelled(new Error("笔记读取超时，请检查网络后重试"));
      controller.abort();
    }, 15_000);
    const cacheKey = JSON.stringify([currentUserId, contentId]);
    let entry: BookAnnotationCache | undefined;
    const read = async () => {
      await requireSameReader(currentUserId);
      checkAborted(controller.signal);
      const cached = bookAnnotationCaches.get(cacheKey);
      if (!options.refresh && cached?.notes && cached.expiresAt > Date.now()) {
        await requireSameReader(currentUserId);
        checkAborted(controller.signal);
        options.onProgress?.({ notes: cached.notes, complete: true });
        await requireSameReader(currentUserId);
        checkAborted(controller.signal);
        return cached.notes;
      }
      entry = { contentId, expiresAt: 0 };
      if (bookAnnotationCaches.size >= 8 && !bookAnnotationCaches.has(cacheKey)) {
        bookAnnotationCaches.delete(bookAnnotationCaches.keys().next().value!);
      }
      bookAnnotationCaches.set(cacheKey, entry);
      const notes = new Map<string, AnnotationThread>();
      let afterId: string | null = null;
      while (true) {
        await requireSameReader(currentUserId);
        checkAborted(controller.signal);
        const { data, error } = await rpc("get_my_book_annotations", {
          p_content_id: contentId, p_after_id: afterId, p_limit: 100,
        }, currentUserId, controller.signal);
        const result = resultOrThrow<unknown>(data, error);
        if (!Array.isArray(result)) throw new Error("笔记服务返回了无效结果，请重试");
        await requireSameReader(currentUserId);
        checkAborted(controller.signal);
        const page = result as AnnotationThread[];
        for (const thread of personalBookNotes(page, currentUserId)) notes.set(thread.id, thread);
        const complete = page.length < 100;
        const loaded = [...notes.values()];
        options.onProgress?.({ notes: loaded, complete });
        // A callback may close the panel or switch accounts before we continue.
        await requireSameReader(currentUserId);
        checkAborted(controller.signal);
        if (complete) {
          if (bookAnnotationCaches.get(cacheKey) === entry) {
            entry.notes = loaded;
            entry.expiresAt = Date.now() + 60_000;
          }
          return loaded;
        }
        const nextId = page.at(-1)?.id;
        if (!nextId || (afterId !== null && nextId <= afterId)) throw new Error("笔记分页未能继续，请重试");
        afterId = nextId;
      }
    };
    try {
      return await Promise.race([read(), cancelled]);
    } catch (reason) {
      if (entry && bookAnnotationCaches.get(cacheKey) === entry) bookAnnotationCaches.delete(cacheKey);
      throw reason;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** One bounded page of public book discussions; private thoughts never enter this view. */
  async function loadPublicBookAnnotations(contentId: string, currentUserId: string | null, options: PublicBookAnnotationOptions = {}): Promise<PublicBookAnnotationPage> {
    if (!currentUserId) return { notes: [], nextCursor: null };
    checkAborted(options.signal);
    const controller = new AbortController();
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const abort = () => {
      const error = new Error("笔记读取已取消"); error.name = "AbortError";
      rejectCancelled(error); controller.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      rejectCancelled(new Error("笔记读取超时，请检查网络后重试")); controller.abort();
    }, 15_000);
    const read = async (): Promise<PublicBookAnnotationPage> => {
      await requireSameReader(currentUserId);
      checkAborted(controller.signal);
      const { data, error } = await rpc("get_public_book_annotations", {
        p_content_id: contentId, p_after_id: options.afterId ?? null, p_limit: 100,
      }, currentUserId, controller.signal);
      const result = resultOrThrow<unknown>(data, error);
      if (!Array.isArray(result)) throw new Error("笔记服务返回了无效结果，请重试");
      await requireSameReader(currentUserId);
      checkAborted(controller.signal);
      const page = result as AnnotationThread[];
      const nextCursor = page.length === 100 ? page.at(-1)?.id ?? null : null;
      if (page.length > 100 || (page.length === 100 && (!nextCursor || (options.afterId && nextCursor <= options.afterId)))) throw new Error("笔记分页未能继续，请重试");
      return {
        notes: page.filter((thread) => thread.publiclyVisible === true).map((thread) => ({
          ...thread, comments: thread.comments.filter((comment) => comment.visibility === "public"),
        })),
        nextCursor,
      };
    };
    try { return await Promise.race([read(), cancelled]); }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
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
      if (subject.contentType === "book") invalidateBookAnnotations(subject.contentId);
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

  return { loadAnnotationThreads, loadMyBookAnnotations, loadPublicBookAnnotations, createAnnotation, addAnnotationComment, reportAnnotationComment, setAnnotationCommentLike, deleteMyAnnotationMark };
}
