import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountConfirmation from "@/account/AccountConfirmation";

const auth = vi.hoisted(() => ({
  confirmSignupEmail: vi.fn(),
  resendSignupConfirmation: vi.fn(),
}));

vi.mock("@/account/auth", () => auth);

function renderConfirmation(path = "/account/confirm?token_hash=test-token") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/account/confirm" element={<AccountConfirmation />} />
        <Route path="/account" element={<div>Account page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.confirmSignupEmail.mockReset().mockResolvedValue(undefined);
  auth.resendSignupConfirmation.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("account email confirmation", () => {
  it("confirms the one-time token and links to the account page", async () => {
    renderConfirmation();

    expect(screen.getByRole("heading", { name: "正在确认邮箱" })).toBeTruthy();
    await waitFor(() =>
      expect(auth.confirmSignupEmail).toHaveBeenCalledWith("test-token"),
    );
    expect(
      await screen.findByRole("heading", { name: "邮箱已经确认" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "进入 JOJO 看报" }));
    expect(await screen.findByText("Account page")).toBeTruthy();
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
