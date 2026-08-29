import { beforeEach, describe, expect, it } from "vitest";
import {
  hydrateTimesReadState,
  markTimesArticleRead,
  useTimesReadStore,
} from "../src/times/readStore";

const LOCAL_STORAGE_KEY = "jojo-times-read-articles-v1";

beforeEach(() => {
  window.localStorage.clear();
  useTimesReadStore.setState({ readById: {} });
});

describe("Times viewed history", () => {
  it("restores locally viewed articles without an account or backend", () => {
    markTimesArticleRead("article-one");
    useTimesReadStore.setState({ readById: {} });

    hydrateTimesReadState(["article-one", "article-two"]);

    expect(useTimesReadStore.getState().readById).toEqual({
      "article-one": true,
      "article-two": false,
    });
  });

  it("keeps a bounded, recency-ordered local history", () => {
    window.localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify(Array.from({ length: 5_000 }, (_, index) => `article-${index}`)),
    );

    markTimesArticleRead("article-0");
    markTimesArticleRead("newest-article");

    const stored = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "[]") as string[];
    expect(stored).toHaveLength(5_000);
    expect(stored).not.toContain("article-1");
    expect(stored.at(-2)).toBe("article-0");
    expect(stored.at(-1)).toBe("newest-article");
  });

  it("ignores malformed local storage instead of blocking the timeline", () => {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, "not json");

    expect(() => hydrateTimesReadState(["article-one"])).not.toThrow();
    expect(useTimesReadStore.getState().readById["article-one"]).toBe(false);
  });
});
