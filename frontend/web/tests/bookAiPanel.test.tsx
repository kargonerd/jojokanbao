import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookAiPanel } from "../src/rag/components/BookAiPanel";
import type { RagReference } from "../src/rag/types";

const ragApi = vi.hoisted(() => ({
  askStream: vi.fn((
    params: { question: string },
    onChunk: (text: string) => void,
    onDone: (references?: unknown[], conversationId?: string) => void,
  ) => {
    onChunk(`回答：${params.question}`);
    onDone([], "conversation-1");
    return vi.fn();
  }),
}));

vi.mock("../src/rag/api", () => ragApi);

const references: RagReference[] = [{
  citationId: "J1",
  datasetId: "dataset",
  itemId: "item",
  targetId: "chapter:1",
  title: "第一章",
}];

function renderPanel(props: { initialQuestion?: string; initialAnswer?: string } = {}) {
  return render(
    <MemoryRouter>
      <BookAiPanel
        bookTitle="测试书"
        datasetId="dataset"
        itemId="item"
        manifestObject="manifest"
        initialQuestion={props.initialQuestion}
        initialAnswer={props.initialAnswer}
        initialReferences={props.initialAnswer ? references : undefined}
        panelClass=""
        onClose={() => {}}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ragApi.askStream.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("BookAiPanel actions", () => {
  it("copies the answer as plain text with numbered citations", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPanel({ initialAnswer: "## 结论\n\n这是**回答**。[cite:J1]" });

    fireEvent.click(screen.getByRole("button", { name: "复制回答文本" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("结论\n\n这是回答。[1]"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制"));
  });

  it("falls back to a selection copy when the Clipboard API rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderPanel({ initialAnswer: "这是回答。[cite:J1]" });

    fireEvent.click(screen.getByRole("button", { name: "复制回答文本" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制"));
  });

  it("regenerates the last answer with the same question", async () => {
    renderPanel({ initialQuestion: "什么是调查研究？" });

    const regenerate = await screen.findByRole("button", { name: "重新生成回答" });
    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(1));
    fireEvent.click(regenerate);

    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(2));
    expect(ragApi.askStream.mock.calls[1]?.[0]).toMatchObject({
      question: "什么是调查研究？",
      history: [],
    });
  });
});
