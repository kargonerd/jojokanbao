import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAccountSessionStore } from "../account/session";
import { loadNotifications, loadUnreadNotificationCount, markNotificationRead } from "./api";
import { useNotificationStore } from "./store";
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
  const userId = useAccountSessionStore((state) => state.userId);
  const [items, setItems] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(Boolean(userId));
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const setUnreadCount = useNotificationStore((state) => state.setUnreadCount);
  const adjustUnreadCount = useNotificationStore((state) => state.adjustUnreadCount);
  const unreadCount = useNotificationStore((state) => state.unreadCount);
  useEffect(() => {
    if (!userId) {
      setItems([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([loadNotifications(), loadUnreadNotificationCount()])
      .then(([loaded, count]) => {
        if (!active) return;
        setItems(loaded);
        setHasMore(loaded.length === 50);
        setUnreadCount(count);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [setUnreadCount, userId]);

  async function markAllRead() {
    if (!unreadCount || busy) return;
    setBusy(true);
    setError("");
    try {
      await markNotificationRead();
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt: now }));
      setUnreadCount(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    const lastItem = items.at(-1);
    const before = lastItem ? { id: lastItem.id, createdAt: lastItem.createdAt } : undefined;
    if (!before || busy) return;
    setBusy(true);
    setError("");
    try {
      const loaded = await loadNotifications(50, before);
      setItems((current) => [...current, ...loaded.filter((item) => !current.some((entry) => entry.id === item.id))]);
      setHasMore(loaded.length === 50);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function markOneRead(item: UserNotification) {
    if (item.readAt) return;
    const now = new Date().toISOString();
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: now } : entry));
    adjustUnreadCount(-1);
    void markNotificationRead(item.id).catch((reason) => {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: null } : entry));
      adjustUnreadCount(1);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }

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
        <button type="button" disabled={!unreadCount || busy} onClick={() => void markAllRead()}>{busy ? "处理中…" : "全部标为已读"}</button>
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
      {hasMore ? <button type="button" className="notifications-more" disabled={busy} onClick={() => void loadMore()}>{busy ? "正在读取…" : "加载更早通知"}</button> : null}
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
