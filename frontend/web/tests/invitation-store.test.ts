import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalInvitationStore } from "@/account/invitationStore";

const repository = vi.hoisted(() => ({
  getStatus: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@/account/auth", () => ({
  personalInvitationRepository: repository,
}));

vi.mock("@jojo/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@jojo/auth")>();
  return {
    ...original,
    getAuthErrorMessage: () => "账号服务暂时不可用。",
  };
});

beforeEach(() => {
  repository.getStatus.mockReset();
  repository.generate.mockReset();
  usePersonalInvitationStore.setState({
    ownerUserId: null,
    status: null,
    loading: false,
    generating: false,
    error: null,
  });
});

describe("personal invitation store", () => {
  it("loads status for the current account", async () => {
    repository.getStatus.mockResolvedValue({
      allocated: true,
      code: "K7MP4X",
      redeemed: false,
      expires_at: "2026-09-01T00:00:00Z",
      disabled: false,
    });

    await usePersonalInvitationStore.getState().load("reader-1");

    expect(usePersonalInvitationStore.getState()).toMatchObject({
      ownerUserId: "reader-1",
      loading: false,
      status: { allocated: true, code: "K7MP4X" },
    });
  });

  it("ignores a response from the previous account", async () => {
    let finishFirstRequest!: (value: unknown) => void;
    repository.getStatus
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirstRequest = resolve;
      }))
      .mockResolvedValueOnce({ allocated: false, redeemed: false });

    const firstRequest = usePersonalInvitationStore.getState().load("reader-1");
    await usePersonalInvitationStore.getState().load("reader-2");
    finishFirstRequest({
      allocated: true,
      code: "OLD123",
      redeemed: false,
      expires_at: null,
      disabled: false,
    });
    await firstRequest;

    expect(usePersonalInvitationStore.getState()).toMatchObject({
      ownerUserId: "reader-2",
      status: { allocated: false, redeemed: false },
    });
  });

  it("does not expose a code while another account is loading", () => {
    usePersonalInvitationStore.setState({
      ownerUserId: "reader-1",
      status: {
        allocated: true,
        code: "K7MP4X",
        redeemed: false,
        expires_at: null,
        disabled: false,
      },
    });
    repository.getStatus.mockReturnValue(new Promise(() => {}));

    void usePersonalInvitationStore.getState().load("reader-2");

    expect(usePersonalInvitationStore.getState()).toMatchObject({
      ownerUserId: "reader-2",
      status: null,
      loading: true,
    });
  });
});
