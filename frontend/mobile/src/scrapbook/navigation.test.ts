import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapbookEntry } from "@jojo/auth";
import { openClippingSource } from "./navigation";

const mocks = vi.hoisted(() => ({ alert: vi.fn(), navigate: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
const navigation = { navigate: mocks.navigate } as unknown as Parameters<typeof openClippingSource>[0];
function clipping(contentUrl: string, quote = "铁路通车"): ScrapbookEntry {
  return { id: "test", contentType: "newspaper", contentId: "rmrb:19660701", contentTitle: "人民日报",
    sectionId: "page-5", locationLabel: "1966-07-01 · 第5版", contentUrl, quote, note: "", collection: "",
    createdAt: "2026-09-08", updatedAt: "2026-09-08" };
}
beforeEach(() => vi.clearAllMocks());
describe("native clipping source navigation", () => {
  it("keeps periodical page numbers and the saved excerpt for precise location", () => {
    openClippingSource(navigation, clipping("/archive/rmrb/19660701#page-5"));
    expect(mocks.navigate).toHaveBeenCalledWith("Reader", { publication: "rmrb", issueId: "19660701", page: 5, searchQuery: undefined, searchQuote: "铁路通车" });
  });
  it("preserves a saved search query and its exact excerpt", () => {
    openClippingSource(navigation, clipping("/archive/rmrb/19660701?query=铁路&quote=首条铁路#page-12"));
    expect(mocks.navigate).toHaveBeenCalledWith("Reader", expect.objectContaining({ page: 12, searchQuery: "铁路", searchQuote: "首条铁路" }));
  });
  it("uses a book quote fallback and refuses foreign source URLs", () => {
    openClippingSource(navigation, clipping("/book/test/one?chapter=chapter-3"));
    expect(mocks.navigate).toHaveBeenCalledWith("BookReader", expect.objectContaining({ datasetId: "test", itemKey: "one", initialChapterId: "chapter-3", initialText: "铁路通车" }));
    mocks.navigate.mockClear();
    openClippingSource(navigation, clipping("https://foreign.test/book/test/one"));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalled();
  });
});
