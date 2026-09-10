import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimesArticleImage } from "../src/times/components/TimesArticleImage";
import { TimesImageCarousel } from "../src/times/components/TimesImageCarousel";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Times image preview", () => {
  it("opens an archived image, zooms and closes with keyboard focus restored", () => {
    render(<TimesArticleImage src="blob:archived" alt="Original alt" caption="中文图注" />);
    const trigger = screen.getByRole("button", { name: "放大图片" });
    trigger.focus(); fireEvent.click(trigger);
    const preview = screen.getByRole("dialog", { name: "图片预览" });
    expect(within(preview).getByRole("img").getAttribute("src")).toBe("blob:archived");
    expect(within(preview).getByText("中文图注")).toBeTruthy();
    fireEvent.click(within(preview).getByRole("button", { name: "继续放大" }));
    expect(within(preview).getByRole("button", { name: "适应屏幕" })).toBeTruthy();
    fireEvent(preview, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("previews the current carousel image with its translated caption", () => {
    const items = [1, 2].map((index) => ({ url: `blob:${index}`, caption: `译文 ${index}`,
      asset: { id: String(index), type: "image" as const, object: `${index}.jox`, mediaType: "image/jpeg", size: 1, sha256: "test" } }));
    render(<TimesImageCarousel id="gallery" items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    const preview = screen.getByRole("dialog");
    expect(within(preview).getByRole("img").getAttribute("src")).toBe("blob:2");
    expect(within(preview).getByText("译文 2")).toBeTruthy();
    fireEvent.click(within(preview).getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
