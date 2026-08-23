import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountLogin from "@/account/AccountLogin";
import { AccountCenterPage } from "@/account/pages/AccountCenterPage";

const account = vi.hoisted(() => ({
  auth: {
    initialized: true,
    recoveryPending: false,
    user: { id: "reader-1", email: "reader@example.com" } as {
      id: string;
      email: string;
    } | null,
    profile: {
      id: "reader-1",
      display_name: "雪豹-TGH",
      avatar_path: null,
      created_at: "2026-08-03T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
    },
    busy: false,
    error: null as string | null,
    notice: null as string | null,
    clearFeedback: vi.fn(),
    signOut: vi.fn(),
    sendPasswordReset: vi.fn(),
    verifyPasswordResetCode: vi.fn(),
    completePasswordRecovery: vi.fn(),
    changePassword: vi.fn(),
    deleteAccount: vi.fn(),
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
  authClient: {},
  startAuthSync: account.startAuthSync,
  useAuthStore: (selector?: (state: typeof account.auth) => unknown) =>
    selector ? selector(account.auth) : account.auth,
}));

vi.mock("@/account/invitationStore", () => ({
  usePersonalInvitationStore: () => account.invitation,
}));

beforeEach(() => {
  account.auth.user = { id: "reader-1", email: "reader@example.com" };
  account.auth.recoveryPending = false;
  account.auth.profile.display_name = "雪豹-TGH";
  account.auth.busy = false;
  account.auth.error = null;
  account.auth.notice = null;
  account.auth.clearFeedback.mockClear();
  account.auth.signOut.mockReset().mockResolvedValue(undefined);
  account.auth.sendPasswordReset.mockReset().mockResolvedValue(undefined);
  account.auth.verifyPasswordResetCode.mockReset().mockResolvedValue(undefined);
  account.auth.completePasswordRecovery.mockReset().mockResolvedValue(undefined);
  account.auth.changePassword.mockReset().mockResolvedValue(undefined);
  account.auth.deleteAccount.mockReset().mockResolvedValue(undefined);
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
        <AccountCenterPage userId="reader-1" onForgotPassword={() => undefined} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "邀请码" })).toBeTruthy();
    await waitFor(() => expect(account.invitation.load).toHaveBeenCalledWith("reader-1"));
  });

  it("keeps an authenticated reader on /account and loads their invitation", async () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(screen.queryByRole("heading", { name: "账号" })).toBeNull();
    expect(screen.getByText("雪豹-TGH")).toBeTruthy();
    expect(screen.getByText("读者代号由系统分配，暂不可修改")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "邀请码" })).toBeTruthy();
    expect(screen.getByLabelText("邀请码 K7MP4X")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "换一个邀请码" })).toBeNull();
    expect(screen.queryByText("我的书架")).toBeNull();
    expect(screen.queryByText(/Account dossier/i)).toBeNull();
    expect(screen.queryByText("你的统一账号")).toBeNull();
    expect(screen.getByText("账号资料")).toBeTruthy();
    expect(screen.getByText("reader@example.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换头像" })).toBeNull();
    expect(screen.queryByLabelText("当前密码")).toBeNull();
    expect(screen.getByRole("button", { name: "修改密码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "注销账号" })).toBeTruthy();
    await waitFor(() => expect(account.invitation.load).toHaveBeenCalledWith("reader-1"));
  });

  it("shows an explicit pending state when an older profile has no reader code", () => {
    account.auth.profile.display_name = "";

    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(screen.getByText("代号待分配")).toBeTruthy();
    expect(screen.getByText("正在分配读者代号，请稍后刷新")).toBeTruthy();
  });

  it("generates the reader's first invitation", async () => {
    account.invitation.status = { allocated: false, redeemed: false };
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "生成邀请码" }));

    await waitFor(() => expect(account.invitation.generate).toHaveBeenCalledOnce());
  });

  it("signs out and returns to the app homepage", async () => {
    render(
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/" element={<div>App home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(account.auth.signOut).toHaveBeenCalledOnce());
    expect(await screen.findByText("App home")).toBeTruthy();
  });

  it("reauthenticates to change the password", async () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    const dialog = screen.getByRole("dialog", { name: "修改密码" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "old-password" } });
    fireEvent.change(within(dialog).getByLabelText("新密码"), { target: { value: "new-password" } });
    fireEvent.change(within(dialog).getByLabelText("再次输入新密码"), { target: { value: "new-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存新密码" }));
    await waitFor(() => expect(account.auth.changePassword).toHaveBeenCalledWith("old-password", "new-password"));
  });

  it("lets an authenticated reader reset a forgotten current password by email code", async () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    fireEvent.click(screen.getByRole("button", { name: "忘记当前密码？通过邮箱验证码重设" }));

    const emailInput = screen.getByLabelText("注册邮箱") as HTMLInputElement;
    expect(emailInput.value).toBe("reader@example.com");
    expect(screen.getByRole("button", { name: "返回账号" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await waitFor(() => expect(account.auth.sendPasswordReset).toHaveBeenCalledWith("reader@example.com"));

    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份" }));
    await waitFor(() => expect(account.auth.verifyPasswordResetCode).toHaveBeenCalledWith("reader@example.com", "654321"));

    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "replacement-password" } });
    fireEvent.change(screen.getByLabelText("再次输入新密码"), { target: { value: "replacement-password" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
    await waitFor(() => expect(account.auth.completePasswordRecovery).toHaveBeenCalledWith("replacement-password"));
  });

  it("restores the new-password form when a recovery session remounts the account page", () => {
    account.auth.recoveryPending = true;

    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(screen.getByRole("dialog", { name: "找回密码" })).toBeTruthy();
    expect(screen.getByLabelText("新密码")).toBeTruthy();
    expect(screen.getByLabelText("再次输入新密码")).toBeTruthy();
    expect(screen.queryByLabelText("当前密码")).toBeNull();
  });

  it("keeps account deletion fields behind a destructive confirmation dialog", () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(screen.queryByLabelText("输入“注销账号”确认")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "注销账号" }));

    const dialog = screen.getByRole("dialog", { name: "注销账号" });
    expect(within(dialog).getByLabelText("当前密码")).toBeTruthy();
    expect(within(dialog).getByLabelText("输入“注销账号”确认")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "永久注销账号" })).toBeTruthy();
  });
});
