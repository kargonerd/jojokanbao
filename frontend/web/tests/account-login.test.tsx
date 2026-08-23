import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountLogin from "@/account/AccountLogin";

const auth = vi.hoisted(() => {
  const stopAuthSync = vi.fn();
  return {
    state: {
      initialized: true,
      user: null,
      recoveryPending: false,
      busy: false,
      error: null,
      notice: null,
      clearFeedback: vi.fn(),
      signIn: vi.fn(),
      signUp: vi.fn(),
      confirmSignUp: vi.fn(),
      resendSignUpCode: vi.fn(),
      sendPasswordReset: vi.fn(),
      verifyPasswordResetCode: vi.fn(),
      completePasswordRecovery: vi.fn(),
    },
    startAuthSync: vi.fn(() => stopAuthSync),
    stopAuthSync,
  };
});

vi.mock("@/account/auth", () => ({
  authClient: {},
  startAuthSync: auth.startAuthSync,
  useAuthStore: (selector?: (state: typeof auth.state) => unknown) =>
    selector ? selector(auth.state) : auth.state,
}));

beforeEach(() => {
  auth.state.initialized = true;
  auth.state.user = null;
  auth.state.recoveryPending = false;
  auth.state.busy = false;
  auth.state.error = null;
  auth.state.notice = null;
  auth.state.clearFeedback.mockClear();
  auth.state.signIn.mockReset().mockResolvedValue(undefined);
  auth.state.signUp.mockReset().mockResolvedValue(true);
  auth.state.confirmSignUp.mockReset().mockResolvedValue(undefined);
  auth.state.resendSignUpCode.mockReset().mockResolvedValue(undefined);
  auth.state.sendPasswordReset.mockReset().mockResolvedValue(undefined);
  auth.state.verifyPasswordResetCode.mockReset().mockResolvedValue(undefined);
  auth.state.completePasswordRecovery.mockReset().mockResolvedValue(undefined);
  auth.startAuthSync.mockClear();
  auth.stopAuthSync.mockClear();
});

afterEach(cleanup);

describe("account access", () => {
  it("starts and disposes auth synchronization", () => {
    const view = render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(auth.startAuthSync).toHaveBeenCalledOnce();
    view.unmount();
    expect(auth.stopAuthSync).toHaveBeenCalledOnce();
  });

  it("submits credentials and returns to the reader", async () => {
    render(
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/" element={<div>Reader home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: " reader@example.com " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "strong-password" } });
    fireEvent.click(screen.getAllByRole("button", { name: "登录" }).at(-1)!);

    await waitFor(() => expect(auth.state.signIn).toHaveBeenCalledWith("reader@example.com", "strong-password"));
    expect(await screen.findByText("Reader home")).toBeTruthy();
  });

  it("honors an explicit return target when a session already exists", async () => {
    auth.state.user = { id: "reader-1" } as never;
    render(
      <MemoryRouter initialEntries={["/account?returnTo=%2Fnotifications"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/notifications" element={<div>Notification inbox</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Notification inbox")).toBeTruthy();
  });

  it("does not follow an external return target", async () => {
    auth.state.user = { id: "reader-1" } as never;
    render(
      <MemoryRouter initialEntries={["/account?returnTo=%2F%2Fevil.example"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/" element={<div>Safe home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Safe home")).toBeTruthy();
  });

  it("does not follow a backslash-obfuscated return target", async () => {
    auth.state.user = { id: "reader-1" } as never;
    render(
      <MemoryRouter initialEntries={["/account?returnTo=%2F%5Cevil.example"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/" element={<div>Safe home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Safe home")).toBeTruthy();
  });

  it("opens login and registration in the same book dialog", () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    const dialog = document.querySelector<HTMLDialogElement>(".book-login-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("dialog", { name: "注册" })).toBeTruthy();
    expect(screen.getByLabelText("邀请码")).toBeTruthy();
    expect(
      Array.from(dialog.querySelectorAll("label > span"), (label) =>
        label.textContent,
      ),
    ).toEqual(["邮箱", "密码", "再次输入密码", "邀请码"]);

    fireEvent.click(dialog);
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("confirms invitation registration without flashing the account center, then returns home", async () => {
    let finishConfirmation!: () => void;
    auth.state.confirmSignUp.mockImplementation(() => new Promise<void>((resolve) => {
      finishConfirmation = resolve;
    }));
    const accountRoutes = () => (
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountLogin />} />
          <Route path="/" element={<div>New reader home</div>} />
        </Routes>
      </MemoryRouter>
    );
    const view = render(accountRoutes());

    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    fireEvent.change(screen.getByLabelText("邀请码"), {
      target: { value: " K7MP4X " },
    });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: " reader@example.com " },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "strong-password" },
    });
    fireEvent.change(screen.getByLabelText("再次输入密码"), {
      target: { value: "strong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送注册验证码" }));

    await waitFor(() => expect(auth.state.signUp).toHaveBeenCalledWith({
      invitationCode: "K7MP4X",
      email: "reader@example.com",
      password: "strong-password",
    }));
    expect(await screen.findByLabelText("6 位验证码")).toBeTruthy();
    expect(document.querySelectorAll(".book-account-form__code-slot")).toHaveLength(6);
    expect(screen.queryByText(/Identity proof/i)).toBeNull();
    expect(screen.getByText(/reader@example.com/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并完成注册" }));
    await waitFor(() => expect(auth.state.confirmSignUp).toHaveBeenCalledWith("reader@example.com", "123456"));

    auth.state.user = { id: "reader-1", email: "reader@example.com" } as never;
    view.rerender(accountRoutes());
    expect(screen.queryByRole("heading", { name: "你的统一账号" })).toBeNull();
    expect(screen.getByLabelText("6 位验证码")).toBeTruthy();

    await act(async () => finishConfirmation());
    expect(await screen.findByText("New reader home")).toBeTruthy();
  });

  it("recovers a password with an email code", async () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    fireEvent.change(screen.getByLabelText("注册邮箱"), { target: { value: "reader@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await waitFor(() => expect(auth.state.sendPasswordReset).toHaveBeenCalledWith("reader@example.com"));

    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份" }));
    await waitFor(() => expect(auth.state.verifyPasswordResetCode).toHaveBeenCalledWith("reader@example.com", "654321"));

    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
    fireEvent.change(screen.getByLabelText("再次输入新密码"), { target: { value: "new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
    await waitFor(() => expect(auth.state.completePasswordRecovery).toHaveBeenCalledWith("new-password"));
  });
});
