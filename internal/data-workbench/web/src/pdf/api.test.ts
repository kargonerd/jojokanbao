import { afterEach, describe, expect, it, vi } from "vitest";
import type { Publication, VuePreview } from "../lib/api";
import { pdfApi } from "./api";

const publication: Publication = {
  code: "NEW",
  name: "新报",
  type: "newspaper",
  vue_name: "new",
};

afterEach(() => vi.unstubAllGlobals());

function mockSuccess(payload: unknown = { success: true }) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PDF API contract", () => {
  it("sends persisted new publication config to staging", async () => {
    const fetchMock = mockSuccess({
      success: true,
      task_id: "task",
      staging_id: "staging",
    });
    await pdfApi.stage(
      "C:/pdf",
      publication,
      [{ original: "a.pdf", renamed: "NEW20260101.pdf", success: true }],
      true,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.new_pub_config).toMatchObject({ code: "NEW", name: "新报" });
  });

  it("uses the multi-file endpoint for new publication code changes", async () => {
    const fetchMock = mockSuccess();
    const preview: VuePreview = {
      success: true,
      multi_file_diff: {
        files: [
          {
            filename: "NEWView.vue",
            filepath: "src/views/NEWView.vue",
            status: "added",
            old_code: "",
            new_code: "<template />",
            additions: 1,
            deletions: 0,
          },
        ],
      },
    };

    await pdfApi.applyVue(
      publication,
      preview,
      true,
      "data:image/png;base64,AAAA",
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/publications/NEW/apply-changes",
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.files).toEqual([
      { filepath: "src/views/NEWView.vue", new_code: "<template />" },
    ]);
    expect(body.image_data).toBe("data:image/png;base64,AAAA");
  });
});
