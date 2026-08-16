import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./adminAuth", () => ({
  featureAdminConfigured: false,
  featureAdminAuth: null,
}));

import { FeatureFlagsPage } from "./FeatureFlagsPage";

describe("FeatureFlagsPage", () => {
  it("explains the safe setup state without exposing an unconfigured editor", () => {
    render(<FeatureFlagsPage />);

    expect(screen.getByRole("heading", { name: "功能开关" })).toBeInTheDocument();
    expect(screen.getByText("管理登录尚未配置")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布规则" })).not.toBeInTheDocument();
  });
});
