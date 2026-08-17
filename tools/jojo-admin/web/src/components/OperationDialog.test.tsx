import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationDialog } from "./OperationDialog";

describe("OperationDialog", () => {
  it("uses a medium bare modal so long result IDs stay inside the panel", () => {
    render(
      <OperationDialog
        open
        kicker="MIGRATION APPLIED"
        title="修复版本已追加"
        message="新版本已写入"
        details={[
          {
            label: "Document ID",
            value: "repair-0bf324651af409582c9e6f27eb26e33afbdcb66c",
          },
        ]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByRole("heading", {
      name: "修复版本已追加",
    }).closest("section");
    expect(panel).toHaveClass("operation-dialog");
    expect(panel?.parentElement).toHaveClass("w-[620px]", "bg-transparent");
    expect(screen.getByText(/repair-0bf324/)).toBeInTheDocument();
  });
});
