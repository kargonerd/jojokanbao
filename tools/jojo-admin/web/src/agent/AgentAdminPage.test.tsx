import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  pushCredential: vi.fn(),
}));

vi.mock("./api", () => ({ agentAdminApi: api }));

import { AgentAdminPage } from "./AgentAdminPage";

const readyStatus = {
  operatorConfigured: true,
  serviceConfigured: true,
  targetOrigin: "https://agent.example.com",
  credential: {
    available: true,
    sourceLabel: "Agent OAuth 文件",
    pathHint: "agent/auth.json",
    type: "OAuth",
    expiresAt: "2030-01-01T00:00:00.000Z",
    expired: false,
    error: null,
  },
  canPush: true,
};

describe("AgentAdminPage", () => {
  beforeEach(() => {
    api.status.mockReset();
    api.pushCredential.mockReset();
    api.status.mockResolvedValue(readyStatus);
  });

  afterEach(cleanup);

  it("shows readiness without exposing secrets or a login form", async () => {
    render(<AgentAdminPage />);

    expect(await screen.findByText("本机就绪")).toBeInTheDocument();
    expect(screen.getByText("本机已加载")).toBeInTheDocument();
    expect(screen.getByText("agent/auth.json")).toBeInTheDocument();
    expect(screen.queryByText("~/.codex/auth.json")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /登录/ })).not.toBeInTheDocument();
  });

  it("confirms before pushing the credential", async () => {
    api.pushCredential.mockResolvedValue({
      targetOrigin: "https://agent.example.com",
      pushedAt: "2026-08-16T04:00:00.000Z",
    });
    render(<AgentAdminPage />);

    fireEvent.click(await screen.findByRole("button", { name: "更新 Agent 凭据" }));
    expect(screen.getByText(/上传会消费本地 rotating refresh token/)).toBeInTheDocument();
    expect(screen.getByText(/请重新登录/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));

    await waitFor(() => expect(api.pushCredential).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已更新 https:\/\/agent\.example\.com/)).toBeInTheDocument();
  });

  it("explains how to prepare a missing local credential", async () => {
    api.status.mockResolvedValue({
      ...readyStatus,
      credential: {
        ...readyStatus.credential,
        available: false,
        type: null,
        expiresAt: null,
        error: "没有找到 Agent 专用 Codex OAuth 凭据",
      },
      canPush: false,
    });
    render(<AgentAdminPage />);

    expect(await screen.findByText("需要先准备 Agent 专用 Codex OAuth")).toBeInTheDocument();
    expect(screen.getByText("pnpm --filter @jojo/agent auth:codex")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新 Agent 凭据" })).toBeDisabled();
  });
});
