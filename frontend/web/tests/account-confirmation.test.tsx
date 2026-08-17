import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountConfirmation from "@/account/AccountConfirmation";

const auth = vi.hoisted(() => ({
  confirmSignupEmail: vi.fn(),
  getCurrentReaderDisplayName: vi.fn(),
  resendSignupConfirmation: vi.fn(),
}));

vi.mock("@/account/auth", () => auth);

function renderConfirmation(path = "/account/confirm?token_hash=test-token") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/account/confirm" element={<AccountConfirmation />} />
        <Route path="/account" element={<div>Account page</div>} />
        <Route path="/" element={<div>Platform home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.confirmSignupEmail.mockReset().mockResolvedValue({
    displayName: "雪豹-TGH",
  });
  auth.getCurrentReaderDisplayName.mockReset().mockResolvedValue("雪豹-TGH");
  auth.resendSignupConfirmation.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("account email confirmation", () => {
  it("shows the assigned reader code before linking to the platform homepage", async () => {
    renderConfirmation();

    expect(screen.getByRole("heading", { name: "正在确认邮箱" })).toBeTruthy();
    await waitFor(() =>
      expect(auth.confirmSignupEmail).toHaveBeenCalledWith("test-token"),
    );
    expect(
      await screen.findByRole("heading", { name: "邮箱验证成功" }),
    ).toBeTruthy();
    expect(screen.getByText("雪豹-TGH")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "记住了，进入首页" }));
    expect(await screen.findByText("Platform home")).toBeTruthy();
  });

  it("does not enter the homepage until a reader code is available", async () => {
    auth.confirmSignupEmail.mockResolvedValueOnce({ displayName: null });
    renderConfirmation();

    expect(await screen.findByText("正在分配")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /进入首页/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新读取代号" }));

    expect(await screen.findByText("雪豹-TGH")).toBeTruthy();
    expect(screen.getByRole("link", { name: "记住了，进入首页" })).toBeTruthy();
  });

  it("consumes the token only once under React Strict Mode", async () => {
    render(
      <StrictMode>
        <MemoryRouter
          initialEntries={["/account/confirm?token_hash=strict-token"]}
        >
          <Routes>
            <Route
              path="/account/confirm"
              element={<AccountConfirmation />}
            />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() =>
      expect(auth.confirmSignupEmail).toHaveBeenCalledWith("strict-token"),
    );
    expect(auth.confirmSignupEmail).toHaveBeenCalledOnce();
  });

  it("shows the recovery form when the link has no token", async () => {
    renderConfirmation("/account/confirm");

    expect(
      await screen.findByRole("heading", { name: "确认链接已失效" }),
    ).toBeTruthy();
    expect(auth.confirmSignupEmail).not.toHaveBeenCalled();
  });

  it("resends confirmation without requiring another invitation", async () => {
    auth.confirmSignupEmail.mockRejectedValueOnce(new Error("expired"));
    renderConfirmation();

    await screen.findByRole("heading", { name: "确认链接已失效" });
    fireEvent.change(screen.getByLabelText("注册邮箱"), {
      target: { value: " reader@example.com " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "重新发送确认邮件" }),
    );

    await waitFor(() =>
      expect(auth.resendSignupConfirmation).toHaveBeenCalledWith(
        "reader@example.com",
      ),
    );
    expect(
      await screen.findByText("新的确认邮件已经发出，请使用最新邮件中的链接。"),
    ).toBeTruthy();
  });
});
