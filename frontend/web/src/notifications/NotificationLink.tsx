import { Link } from "react-router-dom";
import { useUnreadNotifications } from "./useUnreadNotifications";
import "./notifications.css";

export function NotificationLink({ className = "" }: { className?: string }) {
  const { userId, unreadCount } = useUnreadNotifications();

  if (!userId) return null;
  const label = unreadCount > 0 ? `通知，${unreadCount} 条未读` : "通知";
  return (
    <Link className={`notification-link ${className}`.trim()} to="/notifications" aria-label={label}>
      <span>通知</span>
      {unreadCount > 0 ? <b aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</b> : null}
    </Link>
  );
}
