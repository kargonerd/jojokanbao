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
      signIn: vi.fn(),
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
  auth.state.signIn.mockReset().mockResolvedValue(undefined);
  auth.startAuthSync.mockClear();
  auth.stopAuthSync.mockClear();
});

afterEach(cleanup);

describe("account login", () => {
  it("starts and disposes auth synchronization", () => {
    const view = render(<MemoryRouter><AccountLogin /></MemoryRouter>);

    expect(auth.startAuthSync).toHaveBeenCalledOnce();
    view.unmount();
    expect(auth.stopAuthSync).toHaveBeenCalledOnce();
  });

  it("submits credentials and returns to the reader", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<AccountLogin />} />
          <Route path="/" element={<div>Reader home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: " reader@example.com " } });
    fireEvent.change(screen.getByPlaceholderText("输入密码"), { target: { value: "strong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录并进入" }));

    await waitFor(() => expect(auth.state.signIn).toHaveBeenCalledWith("reader@example.com", "strong-password"));
    expect(await screen.findByText("Reader home")).toBeTruthy();
  });
});
