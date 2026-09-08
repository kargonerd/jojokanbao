import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createJojoAuthStore, type JojoAuthClient, type JojoAuthController } from "@jojo/auth";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountLogin from "@/account/AccountLogin";

const auth = vi.hoisted(() => ({ controller: null as JojoAuthController | null }));
vi.mock("@/account/auth", () => ({
  authClient: {},
  startAuthSync: () => auth.controller!.startAuthSync(),
  useAuthStore: (selector?: Parameters<JojoAuthController["useAuthStore"]>[0]) => {
    const store = auth.controller!.useAuthStore;
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
    return selector ? selector(state) : state;
  },
}));
vi.mock("@/account/pages/AccountCenterPage", () => ({
  AccountCenterPage: ({ userId, onForgotPassword }: { userId: string; onForgotPassword: () => void }) => (
    <div>Account {userId}<button onClick={onForgotPassword}>忘记密码？</button></div>
  ),
}));

const readerA = { id: "reader-a", email: "a@example.com" };
const readerB = { id: "reader-b", email: "b@example.com" };
const sessionFor = (user: typeof readerA) => ({ user, access_token: `token-${user.id}`, refresh_token: `refresh-${user.id}` });

function createClient(signedIn = false) {
  let session: ReturnType<typeof sessionFor> | null = signedIn ? sessionFor(readerA) : null;
  let onAuthEvent: (event: string, value: typeof session) => void = () => undefined;
  const verifyOtp = vi.fn();
  const updateUser = vi.fn().mockResolvedValue({ data: { user: readerB }, error: null });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const profile = { id: readerA.id, display_name: "读者-ABC", avatar_path: null, created_at: "", updated_at: "" };
  const client = {
    createRecoveryClient: vi.fn(() => ({ auth: { setSession: vi.fn().mockResolvedValue({ error: null }), updateUser, signOut, dispose: vi.fn().mockResolvedValue(undefined) } })),
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
      onAuthStateChange: vi.fn((callback: typeof onAuthEvent) => {
        onAuthEvent = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
      verifyOtp, updateUser, signOut,
    },
    from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: profile, error: null }), abortSignal: vi.fn(),
    }) }) }),
  } as unknown as JojoAuthClient;
  auth.controller = createJojoAuthStore(client);
  return {
    verifyOtp, updateUser, signOut,
    emitRecovery: (user: typeof readerB) => {
      session = sessionFor(user);
      onAuthEvent("PASSWORD_RECOVERY", session);
      return { data: { user, session }, error: null };
    },
  };
}

function AccountRoutes({ mountKey = 0, returnTo = false }: { mountKey?: number; returnTo?: boolean }) {
  return <MemoryRouter initialEntries={[returnTo ? "/account?returnTo=%2Freader" : "/account"]}>
    <Routes>
      <Route path="/account" element={<AccountLogin key={mountKey} />} />
      <Route path="/reader" element={<div>Returned to reader</div>} />
    </Routes>
  </MemoryRouter>;
}

async function enterCodeStep(signedIn: boolean) {
  if (!signedIn) fireEvent.click(await screen.findByRole("button", { name: "登录" }));
  fireEvent.click(await screen.findByRole("button", { name: "忘记密码？" }));
  fireEvent.change(screen.getByLabelText("注册邮箱"), { target: { value: readerB.email } });
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  await screen.findByLabelText("6 位验证码");
}

beforeEach(() => { auth.controller = null; });
afterEach(cleanup);

describe("password recovery with the shared auth store", () => {
  it.each([false, true])("keeps failed OTP on the code form and retries for B while A is signed in: %s", async (signedIn) => {
    const client = createClient(signedIn);
    let finish!: (response: unknown) => void;
    client.verifyOtp.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<AccountRoutes />);
    await enterCodeStep(signedIn);
    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份" }));
    expect(screen.queryByLabelText("新密码")).toBeNull();
    expect(screen.getByText(`正在验证 ${readerB.email}`)).toBeTruthy();

    await act(async () => finish({ data: { user: null, session: null }, error: { code: "otp_expired" } }));
    expect(screen.getByRole("alert").textContent).toContain("验证码已过期");
    expect(screen.queryByLabelText("新密码")).toBeNull();
    expect((screen.getByLabelText("6 位验证码") as HTMLInputElement).value).toBe("000000");
    expect(client.updateUser).not.toHaveBeenCalled();
    expect(auth.controller!.useAuthStore.getState().user?.id ?? null).toBe(signedIn ? readerA.id : null);

    client.verifyOtp.mockImplementationOnce(async () => client.emitRecovery(readerB));
    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份" }));
    await screen.findByLabelText("新密码");
    expect(screen.getByText(`正在验证 ${readerB.email}`)).toBeTruthy();
    expect(auth.controller!.useAuthStore.getState().user?.id).toBe(readerB.id);
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
    fireEvent.change(screen.getByLabelText("再次输入新密码"), { target: { value: "new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
    await waitFor(() => expect(client.updateUser).toHaveBeenCalledWith({ password: "new-password" }));
    expect(await screen.findByText(`Account ${readerB.id}`)).toBeTruthy();
    expect(client.signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("survives the recovery auth callback and a remount without opening passwords or following returnTo early", async () => {
    const client = createClient();
    let finish!: (response: unknown) => void;
    client.verifyOtp.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<AccountRoutes returnTo />);
    await enterCodeStep(false);
    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份" }));
    let response!: ReturnType<typeof client.emitRecovery>;
    act(() => { response = client.emitRecovery(readerB); });
    view.rerender(<AccountRoutes returnTo mountKey={1} />);
    expect(await screen.findByLabelText("6 位验证码")).toBeTruthy();
    expect(screen.queryByLabelText("新密码")).toBeNull();
    expect(screen.queryByText("Returned to reader")).toBeNull();

    await act(async () => finish(response));
    expect(await screen.findByLabelText("新密码")).toBeTruthy();
    expect(screen.queryByText("Returned to reader")).toBeNull();
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
    fireEvent.change(screen.getByLabelText("再次输入新密码"), { target: { value: "new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
    expect(await screen.findByText("Returned to reader")).toBeTruthy();
  });

  it("clears an old verified flow when returning to the account and starting another recovery", async () => {
    const client = createClient();
    client.verifyOtp.mockImplementation(async () => client.emitRecovery(readerB));
    render(<AccountRoutes />);
    await enterCodeStep(false);
    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份" }));
    await screen.findByLabelText("新密码");
    fireEvent.click(screen.getByRole("button", { name: "返回账号" }));
    fireEvent.click(await screen.findByRole("button", { name: "忘记密码？" }));
    expect(screen.getByLabelText("注册邮箱")).toBeTruthy();
    expect(screen.queryByLabelText("新密码")).toBeNull();
    expect(auth.controller!.useAuthStore.getState()).toMatchObject({ recoveryPending: false, recoveryEmail: null });
    expect(client.updateUser).not.toHaveBeenCalled();
  });
});
