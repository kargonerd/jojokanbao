import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./adminAuth", () => ({
  featureAdminConfigured: false,
  featureAdminAuth: null,
}));

import { FeatureFlagsPage } from "./FeatureFlagsPage";

describe("FeatureFlagsPage", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("explains the safe setup state without exposing an unconfigured editor", () => {
    render(<FeatureFlagsPage />);

    expect(screen.getByRole("heading", { name: "功能开关" })).toBeInTheDocument();
    expect(screen.getByText("管理登录尚未配置")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布规则" })).not.toBeInTheDocument();
  });

  it("shows a read-only local review without requiring an administrator login", async () => {
    window.history.replaceState({}, "", "/features?preview=1");
    render(<FeatureFlagsPage />);

    expect(await screen.findByText("本地预览")).toBeInTheDocument();
    expect(screen.getAllByText("agent.chat")).toHaveLength(2);
    expect(await screen.findByDisplayValue("内部测试用户")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发布规则" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "登录管理台" })).not.toBeInTheDocument();
  });
});
