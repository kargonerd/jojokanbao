import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MigrationPreviewDialog } from "./MigrationPreviewDialog";

const preview = {
  migration: {
    version: 1,
    id: "repair-new-id",
    createdAt: "<generated when applied>",
    index: "news-index",
    operation: "repair" as const,
    supersedesId: "original-id",
    document: { title: "修复标题", content: "修复正文" },
    reason: "读者反馈错字",
    state: "pending" as const,
  },
  esPayload: {
    title: "修复标题",
    content: "修复正文",
    supersedesId: "original-id",
  },
  previewHash: "a".repeat(64),
};

describe("MigrationPreviewDialog", () => {
  it("shows both JSON payloads before allowing the write", () => {
    const onApply = vi.fn();
    render(
      <MigrationPreviewDialog
        preview={preview}
        applying={false}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("尚未写入")).toBeInTheDocument();
    expect(screen.getByText("Migration JSON")).toBeInTheDocument();
    expect(screen.getByText("ES Payload")).toBeInTheDocument();
    expect(screen.getAllByText(/读者反馈错字/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "确认写入 ES" }));
    expect(onApply).toHaveBeenCalledOnce();
  });
});
