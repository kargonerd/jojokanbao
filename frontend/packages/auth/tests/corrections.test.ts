import { describe, expect, it, vi } from "vitest";
import type { JojoAuthClient } from "../src/client";
import { createContentCorrectionRepository, validateContentCorrection } from "../src/corrections";

const source = { contentType: "book" as const, contentId: "collection:book", contentTitle: "测试书", contentUrl: "/book/collection/book?chapter=2", sectionId: "2", locationLabel: "第二章", quote: "错误文字" };
const result = { ...source, id: "feedback-id", category: "typo", details: "应为正确文字", status: "pending", createdAt: "2026-09-08T00:00:00Z" };
function setup(data: unknown = result, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, repository: createContentCorrectionRepository({ rpc } as unknown as JojoAuthClient) };
}

describe("content correction repository", () => {
  it("sends reading context and a retry key, leaving ownership and status to the server", async () => {
    const { rpc, repository } = setup();
    expect(await repository.submit(source, "typo", " 应为正确文字 ", "request-id-123456789", "reader")).toEqual(result);
    expect(rpc).toHaveBeenCalledWith("submit_content_correction", {
      p_request_id: "request-id-123456789", p_expected_user_id: "reader", p_content_type: "book", p_content_id: "collection:book",
      p_content_title: "测试书", p_content_url: "/book/collection/book?chapter=2", p_section_id: "2",
      p_location_label: "第二章", p_quote: "错误文字", p_category: "typo", p_details: "应为正确文字",
    });
  });
  it("loads only the caller's history with optional content filtering", async () => {
    const { rpc, repository } = setup([result]);
    expect(await repository.list(source)).toEqual([result]);
    expect(rpc).toHaveBeenCalledWith("get_my_content_corrections", { p_content_type: "book", p_content_id: "collection:book" });
  });
  it("does not treat missing or malformed receipts as successful submissions", async () => {
    await expect(setup(null).repository.submit(source, "typo", "文字错误", "request-id-123456789", "reader")).rejects.toThrow("未能确认");
    await expect(setup({ id: "x" }).repository.submit(source, "typo", "文字错误", "request-id-123456789", "reader")).rejects.toThrow("未能确认");
  });
  it.each(["https://outside.invalid", "//outside.invalid", "/\\outside.invalid", "/book\n/path"])("rejects unsafe reading link %s", async (contentUrl) => {
    const { rpc, repository } = setup();
    await expect(repository.submit({ ...source, contentUrl }, "typo", "文字错误", "request-id-123456789", "reader")).rejects.toThrow("阅读位置无效");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("validates useful descriptions and bounded excerpts", () => {
    expect(() => validateContentCorrection(source, " ")).toThrow("问题说明");
    expect(() => validateContentCorrection({ ...source, quote: "文".repeat(4001) }, "文字错误")).toThrow("摘录过长");
  });
  it("explains migration unavailability without falsely acknowledging receipt", async () => {
    const { repository } = setup(null, { code: "PGRST202", message: "missing RPC" });
    await expect(repository.submit(source, "typo", "文字错误", "request-id-123456789", "reader")).rejects.toThrow("尚未启用");
  });
  it("preserves the caller's retry key after a network error", async () => {
    const { rpc, repository } = setup(null, { message: "Failed to fetch" });
    await expect(repository.submit(source, "typo", "文字错误", "same-request-id-1234", "reader")).rejects.toThrow("仍会保留");
    rpc.mockResolvedValue({ data: result, error: null });
    await repository.submit(source, "typo", "文字错误", "same-request-id-1234", "reader");
    expect(rpc.mock.calls[0][1].p_request_id).toBe(rpc.mock.calls[1][1].p_request_id);
  });
});
