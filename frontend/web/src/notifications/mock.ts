import type { UserNotification } from "./types";

const now = Date.now();

export const mockNotifications: UserNotification[] = [
  {
    id: "mock-tiger-reply-1",
    kind: "annotation.reply",
    title: "回复了你的评论",
    body: "我理解这里是在区分经验本身和对经验的概括，后一句才是作者真正想强调的部分。",
    targetPath: "/library",
    resourceType: "annotation_comment",
    resourceId: "mock-tiger-comment-1",
    payload: {
      contentTitle: "实践论",
      sectionTitle: "认识和实践的关系",
      contentType: "book",
      quote: "感觉只解决现象问题，理论才解决本质问题。",
    },
    actorId: "mock-reader-northeast-tiger-a",
    actorName: "东北虎-ABC",
    readAt: null,
    createdAt: new Date(now - 4 * 60_000).toISOString(),
  },
  {
    id: "mock-tiger-reply-2",
    kind: "annotation.reply",
    title: "回复了你的评论",
    body: "我的看法稍有不同：这句话更像是在提醒读者，抽象之后还必须回到具体实践中检验。",
    targetPath: "/library",
    resourceType: "annotation_comment",
    resourceId: "mock-tiger-comment-2",
    payload: {
      contentTitle: "实践论",
      sectionTitle: "认识和实践的关系",
      contentType: "book",
      quote: "感觉只解决现象问题，理论才解决本质问题。",
    },
    actorId: "mock-reader-northeast-tiger-b",
    actorName: "东北虎-DEF",
    readAt: null,
    createdAt: new Date(now - 9 * 60_000).toISOString(),
  },
  {
    id: "mock-reply-1",
    kind: "annotation.reply",
    title: "回复了你的评论",
    body: "我也觉得这里的重点不是“记住结论”，而是理解作者为什么在这一段突然改变语气。",
    targetPath: "/library",
    resourceType: "annotation_comment",
    resourceId: "mock-comment-1",
    payload: {
      contentTitle: "毛泽东选集 第一卷",
      sectionTitle: "实践论",
      contentType: "book",
      quote: "认识从实践始，经过实践得到了理论的认识，还须再回到实践去。",
    },
    actorId: "mock-reader-1",
    actorName: "红杨spark",
    readAt: null,
    createdAt: new Date(now - 18 * 60_000).toISOString(),
  },
  {
    id: "mock-comment-2",
    kind: "annotation.comment",
    title: "评论了你的划线",
    body: "这句和本章前面的“调查就是解决问题”可以放在一起看，前后其实是同一个论证。",
    targetPath: "/library",
    resourceType: "annotation_comment",
    resourceId: "mock-comment-2",
    payload: {
      contentTitle: "反对本本主义",
      sectionTitle: "没有调查，没有发言权",
      contentType: "book",
      quote: "你对于那个问题不能解决吗？那么，你就去调查那个问题的现状和它的历史吧！",
    },
    actorId: "mock-reader-2",
    actorName: "春潮",
    readAt: null,
    createdAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  },
  {
    id: "mock-reply-3",
    kind: "annotation.reply",
    title: "回复了你的评论",
    body: "你说的“编辑把最重要的一句放在末尾”很准确，我重读时也注意到了这个节奏。",
    targetPath: "/library",
    resourceType: "annotation_comment",
    resourceId: "mock-comment-3",
    payload: {
      contentTitle: "人民日报 · 1978年12月24日",
      sectionTitle: "第一版",
      contentType: "newspaper",
      quote: "把全党工作的着重点转移到社会主义现代化建设上来。",
    },
    actorId: "mock-reader-3",
    actorName: "北窗读报",
    readAt: new Date(now - 24 * 60 * 60_000).toISOString(),
    createdAt: new Date(now - 26 * 60 * 60_000).toISOString(),
  },
  {
    id: "mock-moderation-4",
    kind: "moderation.report_resolved",
    title: "处理了你的举报",
    body: "你举报的评论已经由编辑审核并隐藏。感谢你帮助维护讨论秩序。",
    targetPath: null,
    resourceType: "annotation_report",
    resourceId: "mock-report-4",
    payload: {
      contentTitle: "站务通知",
      contentType: "system",
    },
    actorId: null,
    actorName: "JOJO 编辑部",
    readAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
    createdAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
  },
];

const locallyRead = new Set(mockNotifications.filter((item) => item.readAt).map((item) => item.id));

export function readMockNotifications(before?: string): UserNotification[] {
  return mockNotifications
    .filter((item) => !before || item.createdAt < before)
    .map((item) => locallyRead.has(item.id) ? { ...item, readAt: item.readAt || new Date().toISOString() } : { ...item, readAt: null });
}

export function mockUnreadCount(): number {
  return mockNotifications.filter((item) => !locallyRead.has(item.id)).length;
}

export function markMockNotificationRead(notificationId?: string): number {
  const targets = notificationId ? [notificationId] : mockNotifications.map((item) => item.id);
  let changed = 0;
  for (const id of targets) {
    if (!locallyRead.has(id)) {
      locallyRead.add(id);
      changed += 1;
    }
  }
  return changed;
}
