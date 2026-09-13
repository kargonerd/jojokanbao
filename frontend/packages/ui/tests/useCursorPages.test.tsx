import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCallback, useEffect, useRef, useState } from "react";
import { createUseCursorPages } from "../src/useCursorPages";
const useCursorPages = createUseCursorPages({ useCallback, useEffect, useRef, useState });
afterEach(cleanup);
const entry = (id: string) => ({ id });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
type Page = { items: {id:string}[]; nextCursor:string|null };
describe("cursor pages", () => {
  it("loads only one page until requested and deduplicates overlapping results", async () => {
    const loadPage = vi.fn().mockResolvedValueOnce({ items: [entry("1")], nextCursor: "1" }).mockResolvedValueOnce({ items: [entry("1"),entry("2")], nextCursor: null });
    const { result } = renderHook(() => useCursorPages({ key: "book:a", enabled: true, loadPage }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(result.current.hasMore).toBe(true);
    act(() => { result.current.loadMore(); result.current.loadMore(); });
    await waitFor(() => expect(result.current.items).toEqual([entry("1"),entry("2")]));
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(loadPage.mock.calls[1]?.[0]).toBe("1");
    expect(result.current.hasMore).toBe(false);
  });
  it("aborts closed views and ignores late responses even after reopening", async () => {
    const old = deferred<Page>();
    const loadPage = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ items:[entry("new")],nextCursor:null });
    const { result, rerender } = renderHook(({ enabled }) => useCursorPages({ key: "book", enabled, loadPage }), { initialProps:{enabled:true} });
    const signal = loadPage.mock.calls[0]?.[1] as AbortSignal;
    rerender({enabled:false});
    expect(signal.aborted).toBe(true);
    rerender({enabled:true});
    await waitFor(() => expect(result.current.items).toEqual([entry("new")]));
    await act(async () => old.resolve({items:[entry("old")],nextCursor:null}));
    expect(result.current.items).toEqual([entry("new")]);
  });
  it("hides old account data immediately and does not let an old result overwrite the new account", async () => {
    const old = deferred<Page>(); const loadPage = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({items:[entry("b")],nextCursor:null});
    const {result,rerender}=renderHook(({key})=>useCursorPages({key,enabled:true,loadPage}),{initialProps:{key:"a"}});
    rerender({key:"b"});
    expect(result.current.items).toEqual([]);
    await waitFor(()=>expect(result.current.items).toEqual([entry("b")]));
    await act(async()=>old.resolve({items:[entry("a")],nextCursor:null}));
    expect(result.current.items).toEqual([entry("b")]);
  });
  it("keeps loaded pages after failure and retries the same cursor", async () => {
    const loadPage=vi.fn().mockResolvedValueOnce({items:[entry("1")],nextCursor:"1"}).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({items:[entry("2")],nextCursor:null});
    const {result}=renderHook(()=>useCursorPages({key:"book",enabled:true,loadPage}));
    await waitFor(()=>expect(result.current.loading).toBe(false));
    act(()=>result.current.loadMore());
    await waitFor(()=>expect(result.current.error).toBeTruthy());
    expect(result.current.items).toEqual([entry("1")]);
    act(()=>result.current.retry());
    await waitFor(()=>expect(result.current.items).toEqual([entry("1"),entry("2")]));
    expect(loadPage.mock.calls.slice(1).map(([cursor])=>cursor)).toEqual(["1","1"]);
  });
});
