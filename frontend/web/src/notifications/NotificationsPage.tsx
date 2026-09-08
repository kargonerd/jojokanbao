import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useNotificationInbox } from "./useNotificationInbox";
import type { UserNotification } from "./types";
import "./notifications.css";

function displayTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function textPayload(item: UserNotification, key: string): string {
  return typeof item.payload[key] === "string" ? item.payload[key] as string : "";
}

function safeLocalPath(value: string | null): string | null {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return null;
  return value;
}

export function NotificationsPage() {
  const { userId, unreadCount, items, loading, refreshing, busy, hasMore, error, loadMore, markPageRead, markOneRead } = useNotificationInbox();

  if (!userId) {
    return (
      <main className="notifications-page notifications-page--signed-out">
        <section><h1>登录后查看通知</h1><span>回复、评论和后续站内消息会集中保存在这里。</span><Link to="/account?returnTo=/notifications">登录 / 注册 →</Link></section>
      </main>
    );
  }

  return (
    <main className="notifications-page">
      <header className="notifications-heading">
        <div className="notifications-title"><h1>信箱</h1></div>
        <div className="notifications-summary"><span>{unreadCount ? <><b>{unreadCount}</b> 条新消息</> : "已经全部读完"}</span>
        <button type="button" disabled={!items.some((item) => !item.readAt) || loading || busy} onClick={() => void markPageRead()}>{busy ? "处理中…" : "本页标为已读"}</button>
        </div>
      </header>
      {error ? <p className="notifications-error" role="alert">{error}</p> : null}
      {loading ? <p className="notifications-empty">正在读取通知…</p> : null}
      {!loading && items.length === 0 ? <p className="notifications-empty">还没有通知。</p> : null}
      <ol className="notification-list">
        {items.map((item, index) => {
          const showSeenDivider = index > 0 && !items[index - 1]?.readAt && Boolean(item.readAt);
          const targetPath = safeLocalPath(item.targetPath);
          return <Fragment key={item.id}>
            {showSeenDivider ? <li className="notification-seen-divider" aria-label="上次看到这里"><span>上次看到这里</span></li> : null}
            <li className={`notification-item ${item.readAt ? "" : "is-unread"}`}>
              {targetPath ? (
                <Link to={targetPath} onClick={() => markOneRead(item)}>
                  <NotificationContent item={item} targetPath={targetPath} />
                </Link>
              ) : <NotificationContent item={item} targetPath={null} />}
            </li>
          </Fragment>;
        })}
      </ol>
      {hasMore ? <button type="button" className="notifications-more" disabled={busy || refreshing} onClick={() => void loadMore()}>{busy ? "正在读取…" : "加载更早通知"}</button> : null}
    </main>
  );
}

function NotificationContent({ item, targetPath }: { item: UserNotification; targetPath: string | null }) {
  const actor = item.actorName || "JOJO 编辑部";
  const quote = textPayload(item, "quote");
  const contentTitle = textPayload(item, "contentTitle");
  const sectionTitle = textPayload(item, "sectionTitle");
  const contentType = textPayload(item, "contentType");
  return (
    <article>
      <div className="notification-copy">
        <div className="notification-byline"><b>{actor}</b><span>{item.title}</span>{!item.readAt ? <i>新</i> : null}</div>
        {item.body ? <p>{item.body}</p> : null}
        {quote ? <blockquote><span>你划线的原文</span><p>{quote}</p></blockquote> : null}
        <footer><time>{displayTime(item.createdAt)}</time>{targetPath ? <span>查看讨论 →</span> : null}</footer>
      </div>
      {contentTitle ? <aside><small>{contentType === "newspaper" ? "报刊" : contentType === "book" ? "书籍" : "站务"}</small><strong>{contentTitle}</strong>{sectionTitle ? <span>{sectionTitle}</span> : null}</aside> : null}
    </article>
  );
}
