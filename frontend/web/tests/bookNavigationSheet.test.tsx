// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookNavigationSheet } from "../src/rag/components/BookNavigationSheet";

afterEach(cleanup);

describe("book navigation sheet", () => {
  function renderSheet(onClose = vi.fn()) {
    render(<BookNavigationSheet mobile tab="toc" onTabChange={vi.fn()} onClose={onClose} panelClass=""><div>章节列表</div></BookNavigationSheet>);
    const handle = screen.getByRole("button", { name: "调整书内导航高度" });
    handle.setPointerCapture = vi.fn();
    return { handle, onClose };
  }

  it("dismisses from the reading area and with Escape", () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "关闭书内导航" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("expands on an upward drag and dismisses on a downward drag", () => {
    const { handle, onClose } = renderSheet();
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(handle);
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    const pointer = (type: string, clientY: number) => fireEvent(handle, new MouseEvent(type, { bubbles: true, clientY }));
    pointer("pointerdown", 300);
    pointer("pointermove", 220);
    pointer("pointerup", 220);
    fireEvent.click(handle, { detail: 1 });
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    pointer("pointerdown", 200);
    pointer("pointermove", 310);
    pointer("pointerup", 310);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the sheet open when a drag is cancelled", () => {
    const { handle, onClose } = renderSheet();
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientY: 200 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientY: 320 }));
    fireEvent.pointerCancel(handle);
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ends dragging even when pointer release does not produce a click", () => {
    const { handle } = renderSheet();
    const sheet = screen.getByLabelText("目录面板");
    const pointer = (type: string, clientY: number) => fireEvent(handle, new MouseEvent(type, { bubbles: true, clientY }));
    pointer("pointerdown", 300);
    pointer("pointermove", 230);
    pointer("pointerup", 230);
    const releasedHeight = sheet.style.height;
    pointer("pointermove", 260);
    expect(sheet.style.height).toBe(releasedHeight);
    fireEvent.click(handle, { detail: 0 });
    expect(handle.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts compact tools at their content height and returns there after expansion or a cancelled drag", () => {
    render(<BookNavigationSheet mobile compact title="文字设置" label="文字设置面板" onClose={vi.fn()} panelClass=""><div className="book-tool-sheet-body">字号和纸张颜色</div></BookNavigationSheet>);
    const sheet = screen.getByRole("complementary", { name: "文字设置面板" });
    const handle = screen.getByRole("button", { name: "调整书内导航高度" });
    handle.setPointerCapture = vi.fn();
    vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue({ height: 320 } as DOMRect);
    expect(sheet.style.height).toBe("auto");
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientY: 300 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientY: 340 }));
    expect(sheet.style.height).toBe("280px");
    fireEvent.pointerCancel(handle);
    expect(sheet.style.height).toBe("auto");
    fireEvent.click(handle);
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    expect(sheet.style.height).toContain("100%");
    fireEvent.click(handle);
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    expect(sheet.style.height).toBe("auto");
  });
});
