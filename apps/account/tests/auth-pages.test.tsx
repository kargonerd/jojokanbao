import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "@/pages/LoginPage";
import { RegisterPage } from "@/pages/RegisterPage";

const auth = vi.hoisted(() => ({
  state: {
    user: null,
    busy: false,
    error: null,
    notice: null,
    signIn: vi.fn(),
    signUp: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({
  useAuthStore: () => auth.state,
}));

describe("account auth pages", () => {
  beforeEach(() => {
    auth.state.user = null;
    auth.state.busy = false;
    auth.state.error = null;
    auth.state.notice = null;
    auth.state.signIn.mockReset().mockResolvedValue(undefined);
    auth.state.signUp.mockReset().mockResolvedValue(true);
  });

  it("submits credentials and opens the account page", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/account" element={<div>账号页已打开</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "reader@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("输入密码"), { target: { value: "strong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录账号" }));

    await waitFor(() => expect(auth.state.signIn).toHaveBeenCalledWith("reader@example.com", "strong-password"));
    expect(await screen.findByText("账号页已打开")).toBeInTheDocument();
  });

  it("blocks registration when the two passwords differ", async () => {
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: "JOJO-TEST-INVITATION" } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "reader@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位字符"), { target: { value: "strong-password" } });
    fireEvent.change(screen.getByPlaceholderText("重复输入密码"), { target: { value: "another-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(auth.state.signUp).not.toHaveBeenCalled();
  });

  it("submits the invitation code with the registration details", async () => {
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: " JOJO-ABCD-EFGH-IJKL " } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "读者甲" } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "reader@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("至少 8 位字符"), { target: { value: "strong-password" } });
    fireEvent.change(screen.getByPlaceholderText("重复输入密码"), { target: { value: "strong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    await waitFor(() => expect(auth.state.signUp).toHaveBeenCalledWith({
      invitationCode: "JOJO-ABCD-EFGH-IJKL",
      displayName: "读者甲",
      email: "reader@example.com",
      password: "strong-password",
      emailRedirectTo: "http://localhost:3000/auth/callback",
    }));
  });
});
