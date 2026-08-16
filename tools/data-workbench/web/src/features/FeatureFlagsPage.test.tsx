import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  publish: vi.fn(),
  searchUsers: vi.fn(),
}));

vi.mock("./api", () => ({ featureFlagApi: api }));

import { FeatureFlagsPage } from "./FeatureFlagsPage";

const flag = {
  key: "agent.chat",
  description: "JOJO Agent 对话入口和模型请求",
  emergencyDisabled: false,
  revision: 7,
  updatedAt: "2026-08-16T01:30:00.000Z",
  updatedBy: null,
  rules: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      name: "内部测试用户",
      conditionType: "users" as const,
      serve: true,
      percentage: null,
      bucketBy: null,
      bucketSalt: null,
      startsAt: null,
      endsAt: null,
      enabled: true,
      isFallback: false,
      userIds: [],
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      name: "默认关闭",
      conditionType: "global" as const,
      serve: false,
      percentage: null,
      bucketBy: null,
      bucketSalt: null,
      startsAt: null,
      endsAt: null,
      enabled: true,
      isFallback: true,
      userIds: [],
    },
  ],
};

describe("FeatureFlagsPage", () => {
  beforeEach(() => {
    api.list.mockReset();
    api.publish.mockReset();
    api.searchUsers.mockReset();
    api.list.mockResolvedValue([flag]);
    api.searchUsers.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it("opens the local operator editor without a browser login", async () => {
    render(<FeatureFlagsPage />);

    expect(await screen.findByText("本机 Operator")).toBeInTheDocument();
    expect(screen.getAllByText("agent.chat")).toHaveLength(2);
    expect(await screen.findByDisplayValue("内部测试用户")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "登录管理台" })).not.toBeInTheDocument();
  });

  it("publishes emergency disable ahead of the ordered rules", async () => {
    api.publish.mockResolvedValue({ ...flag, emergencyDisabled: true, revision: 8 });
    render(<FeatureFlagsPage />);

    const emergency = await screen.findByRole("checkbox", { name: /紧急关闭/ });
    fireEvent.click(emergency);
    fireEvent.change(screen.getByPlaceholderText("说明为什么修改这组规则"), { target: { value: "紧急停用" } });
    fireEvent.click(screen.getByRole("button", { name: "发布规则" }));

    await waitFor(() => expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({
      key: "agent.chat",
      emergencyDisabled: true,
      expectedRevision: 7,
      reason: "紧急停用",
    })));
    expect(await screen.findByText("已发布 revision 8")).toBeInTheDocument();
  });

  it("shows a useful local configuration error", async () => {
    api.list.mockRejectedValue(new Error("JOJO_OPERATOR_TOKEN 未配置或长度不足 32 位"));
    render(<FeatureFlagsPage />);

    expect(await screen.findByText("无法连接功能开关")).toBeInTheDocument();
    expect(screen.getByText(/JOJO_OPERATOR_TOKEN 未配置/)).toBeInTheDocument();
  });
});
