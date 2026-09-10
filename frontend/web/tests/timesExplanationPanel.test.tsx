import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimesExplanationPanel } from "../src/times/components/TimesExplanationPanel";

afterEach(cleanup);

describe("TimesExplanationPanel", () => {
  it("animates during generation and replaces progress with a retry action on failure", () => {
    const props = { anchor: { quote: "原油", prefix: "", suffix: "", startOffset: 0, endOffset: 2 }, answer: "", onClose: vi.fn(), onRetry: vi.fn() };
    const { container, rerender } = render(<TimesExplanationPanel {...props} status="正在生成解释…" error="" />);
    expect(screen.getByRole("status").textContent).toBe("正在生成解释…");
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    rerender(<TimesExplanationPanel {...props} status="" error="连接失败" />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新解释" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
  it("renders sanitized Markdown as readable editorial content", () => {
    const { container } = render(<TimesExplanationPanel
      anchor={{ quote: "vows", prefix: "", suffix: "", startOffset: 0, endOffset: 4 }}
      answer={'**核心解释**\n\n- 外交\n- 防务\n\n<script>alert("bad")</script>'}
      status="解释完成"
      error=""
      onClose={vi.fn()}
    />);

    expect(screen.getByText("核心解释").tagName).toBe("STRONG");
    expect(screen.getByRole("list").textContent).toContain("外交");
    expect(screen.getByRole("list").textContent).toContain("防务");
    expect(screen.queryByText("JOJO TIMES · BETA")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("**核心解释**")).toBeNull();
  });
});
