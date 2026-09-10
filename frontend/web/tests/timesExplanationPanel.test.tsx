import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimesExplanationPanel } from "../src/times/components/TimesExplanationPanel";
import type { ExplanationTurn } from "@jojo/ui/reader-explanation";
import type { TimesExplanationMetadata } from "../src/times/ai";

afterEach(cleanup);
const turn = (values: Partial<ExplanationTurn<TimesExplanationMetadata>> = {}): ExplanationTurn<TimesExplanationMetadata> => ({ question: "", answer: "", status: "", error: "", phase: "complete", ...values });
const props = () => ({ anchor: { quote: "ECB", prefix: "", suffix: "", startOffset: 0, endOffset: 3 }, conversationId: "test", onClose: vi.fn(), onRetry: vi.fn(), onAsk: vi.fn(() => true), onStop: vi.fn() });

describe("TimesExplanationPanel", () => {
  it("animates each turn, preserves the previous answer and offers stop / retry", () => {
    const callbacks = props();
    const first = turn({ answer: "欧洲中央银行", metadata: { model: "gemini", imageCount: 0 } });
    const { container, rerender } = render(<TimesExplanationPanel {...callbacks} turns={[first, turn({ question: "为什么加息？", phase: "pending", status: "正在生成解释…" })]} />);
    expect(screen.getByRole("status").textContent).toBe("正在生成解释…");
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByText("欧洲中央银行")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(callbacks.onStop).toHaveBeenCalledOnce();
    rerender(<TimesExplanationPanel {...callbacks} turns={[first, turn({ question: "为什么加息？", phase: "error", error: "连接失败" })]} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试回答" }));
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
  });

  it("sends follow-ups, rejects whitespace and preserves IME / Shift+Enter input", () => {
    const callbacks = props();
    render(<TimesExplanationPanel {...callbacks} turns={[turn({ answer: "解释" })]} />);
    const input = screen.getByRole("textbox", { name: "继续提问" });
    expect((screen.getByRole("button", { name: "发送 →" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "它和美联储有什么区别？" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(callbacks.onAsk).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onAsk).toHaveBeenCalledWith("它和美联储有什么区别？");
    expect((input as HTMLTextAreaElement).value).toBe("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it("does not send while busy and keeps a draft for the next turn", () => {
    const callbacks = props();
    const { rerender } = render(<TimesExplanationPanel {...callbacks} turns={[turn({ phase: "pending", status: "生成中" })]} />);
    const input = screen.getByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "再举个例子" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onAsk).not.toHaveBeenCalled();
    rerender(<TimesExplanationPanel {...callbacks} turns={[turn({ answer: "完成" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "发送 →" }));
    expect(callbacks.onAsk).toHaveBeenCalledWith("再举个例子");
  });

  it("renders sanitized Markdown and hides an in-flight completion marker", () => {
    const { container } = render(<TimesExplanationPanel {...props()} turns={[turn({
      answer: '**核心解释**\n\n- 外交\n- 防务\n\n<script>alert("bad")</script>\n<!-- JOJO_TIMES_COMP',
    })]} />);
    expect(screen.getByText("核心解释").tagName).toBe("STRONG");
    expect(screen.getByRole("list").textContent).toContain("外交");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("JOJO_TIMES_COMP");
  });
});
