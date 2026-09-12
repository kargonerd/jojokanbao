import { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebView } from "react-native-webview";
import { BookReaderWebView } from "./BookReaderWebView";

const mocks = vi.hoisted(() => ({ inject: vi.fn(), failure: vi.fn(), message: vi.fn(), mounts: 0 }));
vi.mock("react-native-webview", async () => {
  const React = await import("react");
  return { WebView: ({ ref, ...props }: { ref?: import("react").Ref<unknown> }) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mocks.inject }), []);
    React.useEffect(() => { mocks.mounts += 1; }, []);
    return React.createElement("article", props);
  } };
});
let view: ReactTestRenderer;
const native = () => view.root.findByType("article");
const props = { html: "<body><article>chapter</article></body>", bootstrapScript: "bootstrap();", onInitializationError: mocks.failure, onMessage: mocks.message };
const session = () => JSON.parse(native().props.injectedJavaScript.match(/__jojoReaderSessionId = (.*);\n/)[1]) as string;
const page = { type: "reader-page", paged: true, spreadIndex: 0, spreadCount: 2, pageStart: 1, pageEnd: 1, pageCount: 2, pagesPerSpread: 1, scrollProgress: 0 };
const ready = { type: "reader-ready", chapterId: "chapter:11" };
async function send(message: unknown, readerSessionId = session()) {
  await act(async () => native().props.onMessage({ nativeEvent: { data: JSON.stringify({ ...message as object, readerSessionId }) } }));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.mounts = 0;
  await act(async () => { view = create(<BookReaderWebView {...props} />); });
});
afterEach(async () => { await act(async () => view.unmount()); vi.useRealTimers(); });

it("reinjects and rebuilds once even if native onLoadEnd never arrives, then exposes retry", async () => {
  const firstSession = session();
  await act(async () => { vi.advanceTimersByTime(3_000); });
  expect(mocks.inject).toHaveBeenCalledExactlyOnceWith(native().props.injectedJavaScript);
  await act(async () => { vi.advanceTimersByTime(3_000); });
  expect(mocks.mounts).toBe(2);
  expect(session()).not.toBe(firstSession);
  expect(mocks.failure).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(6_000); });
  expect(mocks.failure).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(mocks.mounts).toBe(2);
  expect(mocks.failure).toHaveBeenCalledTimes(1);
});

it("requires both initialized controls and a page report and accepts recovery on the new view", async () => {
  await send(ready);
  await act(async () => { vi.advanceTimersByTime(6_000); });
  expect(mocks.mounts).toBe(2);
  await send(ready); await send(page);
  await act(async () => { vi.advanceTimersByTime(12_000); });
  expect(mocks.mounts).toBe(2);
  expect(mocks.failure).not.toHaveBeenCalled();
});

it("rejects delayed messages from a replaced view and from an unmounted chapter", async () => {
  const oldHandler = native().props.onMessage;
  const oldSession = session();
  await act(async () => { vi.advanceTimersByTime(6_000); });
  const stale = { nativeEvent: { data: JSON.stringify({ type: "reader-boundary", direction: "next", readerSessionId: oldSession }) } };
  await act(async () => { oldHandler(stale); native().props.onMessage(stale); });
  expect(mocks.message).not.toHaveBeenCalled();
  await send({ type: "reader-tap" });
  expect(mocks.message).toHaveBeenCalledTimes(1);
  const activeHandler = native().props.onMessage;
  const activeSession = session();
  await act(async () => view.unmount());
  activeHandler({ nativeEvent: { data: JSON.stringify({ ...page, readerSessionId: activeSession }) } });
  expect(mocks.message).toHaveBeenCalledTimes(1);
});

it("keeps the document, bootstrap and controls stable while saved progress rerenders the parent", async () => {
  const source = native().props.source;
  const script = native().props.injectedJavaScript;
  await send(ready); await send(page);
  await act(async () => view.update(<BookReaderWebView {...props} html="<body>new render</body>" bootstrapScript="changed();" />));
  expect(native().props.source).toBe(source);
  expect(native().props.injectedJavaScript).toBe(script);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(mocks.mounts).toBe(1);
  expect(mocks.failure).not.toHaveBeenCalled();
});

it("forwards imperative controls and supplements the native load-end callback", async () => {
  const ref = createRef<WebView>();
  await act(async () => view.update(<BookReaderWebView {...props} ref={ref} />));
  ref.current?.injectJavaScript("page();");
  expect(mocks.inject).toHaveBeenLastCalledWith("page();");
  await act(async () => native().props.onLoadEnd({}));
  expect(mocks.inject).toHaveBeenLastCalledWith(native().props.injectedJavaScript);
});
