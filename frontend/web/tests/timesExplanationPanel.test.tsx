import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimesExplanationPanel } from "../src/times/components/TimesExplanationPanel";

afterEach(cleanup);

describe("TimesExplanationPanel", () => {
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
