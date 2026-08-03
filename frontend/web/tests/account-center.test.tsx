import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountLogin from "@/account/AccountLogin";
import { AccountCenterPage } from "@/account/pages/AccountCenterPage";

const account = vi.hoisted(() => ({
  auth: {
    initialized: true,
    user: { id: "reader-1", email: "reader@example.com" } as {
      id: string;
      email: string;
    } | null,
    profile: {
      id: "reader-1",
      display_name: "雪豹",
      avatar_path: null,
      created_at: "2026-08-03T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
    },
    busy: false,
    error: null as string | null,
    notice: null as string | null,
    clearFeedback: vi.fn(),
    signOut: vi.fn(),
  },
  invitation: {
    ownerUserId: "reader-1",
    status: {
      allocated: true,
      code: "K7MP4X",
      redeemed: false,
      expires_at: "2026-09-01T00:00:00Z",
      disabled: false,
    } as
      | {
          allocated: true;
          code: string;
          redeemed: boolean;
          expires_at: string | null;
          disabled: boolean;
        }
      | { allocated: false; redeemed: false },
    loading: false,
    generating: false,
    error: null as string | null,
    load: vi.fn(),
    generate: vi.fn(),
  },
  startAuthSync: vi.fn(() => vi.fn()),
}));

vi.mock("@/account/auth", () => ({
  startAuthSync: account.startAuthSync,
  useAuthStore: (selector?: (state: typeof account.auth) => unknown) =>
    selector ? selector(account.auth) : account.auth,
}));

vi.mock("@/account/invitationStore", () => ({
  usePersonalInvitationStore: () => account.invitation,
}));

beforeEach(() => {
  account.auth.user = { id: "reader-1", email: "reader@example.com" };
  account.auth.profile.display_name = "雪豹";
  account.auth.busy = false;
  account.auth.error = null;
  account.auth.notice = null;
  account.auth.clearFeedback.mockClear();
  account.auth.signOut.mockReset().mockResolvedValue(undefined);
  account.invitation.status = {
    allocated: true,
    code: "K7MP4X",
    redeemed: false,
    expires_at: "2026-09-01T00:00:00Z",
    disabled: false,
  };
  account.invitation.loading = false;
  account.invitation.generating = false;
  account.invitation.error = null;
  account.invitation.load.mockReset().mockResolvedValue(undefined);
  account.invitation.generate.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("account center", () => {
  it("keeps using the confirmed user id while the auth store is signing out", async () => {
    account.auth.user = null;

    render(
      <MemoryRouter>
        <AccountCenterPage userId="reader-1" />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "我的邀请码" })).toBeTruthy();
    await waitFor(() => expect(account.invitation.load).toHaveBeenCalledWith("reader-1"));
  });

  it("keeps an authenticated reader on /account and loads their invitation", async () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "我的邀请码" })).toBeTruthy();
    expect(screen.getByText("雪豹")).toBeTruthy();
    expect(screen.getByLabelText("邀请码 K7MP4X")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("账号资料")).toBeNull();
    await waitFor(() => expect(account.invitation.load).toHaveBeenCalledWith("reader-1"));
  });

  it("generates the reader's first invitation", async () => {
    account.invitation.status = { allocated: false, redeemed: false };
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "生成邀请码" }));

    await waitFor(() => expect(account.invitation.generate).toHaveBeenCalledOnce());
  });

  it("signs out and returns to the archive", async () => {
    render(
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/archive" element={<div>Archive home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(account.auth.signOut).toHaveBeenCalledOnce());
    expect(await screen.findByText("Archive home")).toBeTruthy();
  });
});
