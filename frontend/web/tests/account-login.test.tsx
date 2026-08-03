import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountLogin from "@/account/AccountLogin";

const auth = vi.hoisted(() => {
  const stopAuthSync = vi.fn();
  return {
    state: {
      initialized: true,
      user: null,
      busy: false,
      error: null,
      notice: null,
      clearFeedback: vi.fn(),
      signIn: vi.fn(),
      signUp: vi.fn(),
    },
    startAuthSync: vi.fn(() => stopAuthSync),
    stopAuthSync,
  };
});

vi.mock("@/account/auth", () => ({
  startAuthSync: auth.startAuthSync,
  useAuthStore: (selector?: (state: typeof auth.state) => unknown) =>
    selector ? selector(auth.state) : auth.state,
}));

beforeEach(() => {
  auth.state.initialized = true;
  auth.state.user = null;
  auth.state.busy = false;
  auth.state.error = null;
  auth.state.notice = null;
  auth.state.clearFeedback.mockClear();
  auth.state.signIn.mockReset().mockResolvedValue(undefined);
  auth.state.signUp.mockReset().mockResolvedValue(true);
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

  it("opens login and registration in the same book dialog", () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    const dialog = document.querySelector<HTMLDialogElement>(".book-login-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("dialog", { name: "注册" })).toBeTruthy();
    expect(screen.getByLabelText("邀请码")).toBeTruthy();

    fireEvent.click(dialog);
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("submits invitation registration and shows the confirmation step", async () => {
    render(<MemoryRouter><AccountLogin /></MemoryRouter>);

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
    fireEvent.click(screen.getByRole("button", { name: "注册账号" }));

    await waitFor(() => expect(auth.state.signUp).toHaveBeenCalledWith({
      invitationCode: "K7MP4X",
      email: "reader@example.com",
      password: "strong-password",
      emailRedirectTo: "http://localhost:3000/account",
    }));
    expect(await screen.findByText("请检查邮箱")).toBeTruthy();
    expect(screen.getByText(/reader@example.com/)).toBeTruthy();
  });
});
