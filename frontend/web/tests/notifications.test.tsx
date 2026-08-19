import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationLink } from "../src/notifications/NotificationLink";
import { NotificationsPage } from "../src/notifications/NotificationsPage";
import { resetNotifications, useNotificationStore } from "../src/notifications/store";
import { usePlatformAccountStore } from "../src/platform/accountSession";

const api = vi.hoisted(() => ({
  loadNotifications: vi.fn(),
  loadUnreadNotificationCount: vi.fn(),
  markNotificationRead: vi.fn(),
}));

vi.mock("../src/notifications/api", () => api);

const reply = {
  id: "notification-1",
  kind: "annotation.reply",
  title: "回复了你的评论",
  body: "我也这样理解。",
  targetPath: "/book/mao/volume-1?chapter=chapter-1&discussion=annotation-1",
  resourceType: "annotation_comment",
  resourceId: "comment-2",
  payload: { quote: "被划线的原文", contentTitle: "测试书籍", contentType: "book" },
  actorId: "reader-2",
  actorName: "另一位读者",
  readAt: null,
  createdAt: "2026-08-19T10:00:00Z",
};

const earlierReply = {
  ...reply,
  id: "notification-2",
  resourceId: "comment-3",
  actorId: "reader-3",
  actorName: "较早的读者",
  readAt: "2026-08-18T10:00:00Z",
  createdAt: "2026-08-18T09:00:00Z",
};

beforeEach(() => {
  resetNotifications();
  usePlatformAccountStore.setState({ initialized: true, userId: "reader-1", displayName: "收件人" });
  api.loadNotifications.mockReset();
  api.loadUnreadNotificationCount.mockReset();
  api.markNotificationRead.mockReset();
  api.loadNotifications.mockResolvedValue([reply, earlierReply]);
  api.loadUnreadNotificationCount.mockResolvedValue(1);
  api.markNotificationRead.mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("generic notifications", () => {
  it("shows an unread reply and marks it read before following the local target", async () => {
    render(
      <MemoryRouter initialEntries={["/notifications"]}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/book/:dataset/:item" element={<p>书籍目标</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "信箱" })).toBeTruthy();
    expect(screen.queryByText("NOTICES / 通知")).toBeNull();
    const link = await screen.findByRole("link", { name: /另一位读者.*回复了你的评论/ });
    expect(screen.getAllByText("被划线的原文")).toHaveLength(2);
    expect(screen.getByLabelText("上次看到这里")).toBeTruthy();
    expect(screen.getAllByText("测试书籍")).toHaveLength(2);
    fireEvent.click(link);

    expect(await screen.findByText("书籍目标")).toBeTruthy();
    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith("notification-1"));
    expect(useNotificationStore.getState().unreadCount).toBe(0);
  });

  it("polls the shared unread count only for a signed-in reader", async () => {
    const view = render(<MemoryRouter><NotificationLink /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: "通知，1 条未读" })).toBeTruthy();
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);

    act(() => usePlatformAccountStore.setState({ initialized: true, userId: null, displayName: null }));
    expect(screen.queryByRole("link", { name: /通知/ })).toBeNull();
    expect(useNotificationStore.getState().unreadCount).toBe(0);
    view.unmount();
  });

  it("does not load a signed-out inbox", () => {
    usePlatformAccountStore.setState({ initialized: true, userId: null, displayName: null });
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "登录后查看通知" })).toBeTruthy();
    expect(api.loadNotifications).not.toHaveBeenCalled();
  });

  it("shows each reader's complete generated display name", async () => {
    api.loadNotifications.mockResolvedValue([
      { ...reply, id: "tiger-1", actorId: "reader-tiger-a", actorName: "东北虎-ABC" },
      { ...earlierReply, id: "tiger-2", actorId: "reader-tiger-b", actorName: "东北虎-DEF" },
    ]);
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);

    expect(await screen.findByText("东北虎-ABC")).toBeTruthy();
    expect(screen.getByText("东北虎-DEF")).toBeTruthy();
    expect(screen.queryByText("东北虎", { exact: true })).toBeNull();
  });
});
