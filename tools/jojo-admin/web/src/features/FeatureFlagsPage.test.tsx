import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
  searchUsers: vi.fn(),
}));

vi.mock("./api", () => ({ featureFlagApi: api }));

import { FeatureFlagsPage } from "./FeatureFlagsPage";

const flag = {
  key: "rag.workspace",
  description: "RAG 工作区路由与请求",
  revision: 7,
  updatedAt: "2026-08-16T01:30:00.000Z",
  config: {},
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
  history: [
    {
      revision: 6,
      rules: [],
      config: {},
      reason: "仅对白名单开放",
      requestId: "request-6",
      updatedAt: "2026-08-15T01:30:00.000Z",
    },
    {
      revision: 7,
      rules: [],
      config: {},
      reason: "调整内部名单",
      requestId: "request-7",
      updatedAt: "2026-08-16T01:30:00.000Z",
    },
  ],
};

const annotationFlag = {
  ...flag,
  key: "reader.annotations",
  description: "划线、想法和 AI 解释数据",
  revision: 1,
  config: { publicMarkThreshold: 2 },
  history: [{
    revision: 1,
    rules: flag.rules,
    config: { publicMarkThreshold: 2 },
    reason: "初始配置",
    requestId: null,
    updatedAt: "2026-08-16T01:30:00.000Z",
  }],
};

describe("FeatureFlagsPage", () => {
  beforeEach(() => {
    api.list.mockReset();
    api.publish.mockReset();
    api.rollback.mockReset();
    api.searchUsers.mockReset();
    api.list.mockResolvedValue([flag]);
    api.searchUsers.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it("opens the local operator editor without a browser login", async () => {
    render(<FeatureFlagsPage />);

    expect(await screen.findByText("本机 Operator")).toBeInTheDocument();
    expect(screen.getAllByText("rag.workspace")).toHaveLength(2);
    expect(await screen.findByDisplayValue("内部测试用户")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "登录管理台" })).not.toBeInTheDocument();
  });

  it("publishes the ordered rules against the selected revision", async () => {
    api.publish.mockResolvedValue({ ...flag, revision: 8 });
    render(<FeatureFlagsPage />);

    await screen.findByText("修改记录");
    fireEvent.change(screen.getByPlaceholderText("说明为什么修改这组规则"), { target: { value: "调整灰度规则" } });
    fireEvent.click(screen.getByRole("button", { name: "发布更改" }));

    await waitFor(() => expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({
      key: "rag.workspace",
      config: {},
      expectedRevision: 7,
      reason: "调整灰度规则",
    })));
    expect(await screen.findByText("已发布 revision 8")).toBeInTheDocument();
  });

  it("rolls a historical snapshot forward as a new revision", async () => {
    api.rollback.mockResolvedValue({
      ...flag,
      revision: 8,
      history: [...flag.history, {
        revision: 8,
        rules: [],
        config: {},
        reason: "回滚到 revision 6",
        requestId: "request-8",
        updatedAt: "2026-08-16T02:30:00.000Z",
      }],
    });
    render(<FeatureFlagsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "回滚到 revision 6" }));

    await waitFor(() => expect(api.rollback).toHaveBeenCalledWith(expect.objectContaining({
      key: "rag.workspace",
      targetRevision: 6,
      expectedRevision: 7,
    })));
    expect(await screen.findByText("已回滚到 revision 6，当前为 revision 8")).toBeInTheDocument();
  });

  it("publishes the annotation visibility threshold with the same revision", async () => {
    api.list.mockResolvedValue([annotationFlag]);
    api.publish.mockResolvedValue({
      ...annotationFlag,
      revision: 2,
      config: { publicMarkThreshold: 5 },
    });
    render(<FeatureFlagsPage />);

    const threshold = await screen.findByRole("spinbutton", { name: "划线公开阈值" });
    expect(threshold).toHaveValue(2);
    fireEvent.change(threshold, { target: { value: "5" } });
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "划线公开阈值" })).toHaveValue(5));
    fireEvent.change(screen.getByPlaceholderText("说明为什么修改这组规则"), { target: { value: "调整公开人数" } });
    fireEvent.click(screen.getByRole("button", { name: "发布更改" }));

    await waitFor(() => expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({
      key: "reader.annotations",
      config: { publicMarkThreshold: 5 },
      expectedRevision: 1,
    })));
  });

  it("shows a useful local configuration error", async () => {
    api.list.mockRejectedValue(new Error("JOJO_OPERATOR_TOKEN 未配置或长度不足 32 位"));
    render(<FeatureFlagsPage />);

    expect(await screen.findByText("无法连接功能开关")).toBeInTheDocument();
    expect(screen.getByText(/JOJO_OPERATOR_TOKEN 未配置/)).toBeInTheDocument();
  });
});
