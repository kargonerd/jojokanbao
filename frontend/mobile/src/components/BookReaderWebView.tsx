import { useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { WebView, type WebViewProps } from "react-native-webview";
import { parseBookReaderMessage } from "../lib/bookReaderBridge";

type Props = Omit<WebViewProps, "source" | "injectedJavaScript"> & {
  ref?: Ref<WebView>;
  html: string;
  bootstrapScript: string;
  onInitializationError: () => void;
};

export function BookReaderWebView({ ref, html, bootstrapScript, onMessage, onLoadEnd, onInitializationError, ...props }: Props) {
  // The parent remounts this view for a new chapter or display setting. Saved
  // progress and other React updates must not reload the current document.
  const [initial] = useState(() => ({ html, bootstrapScript }));
  const [attempt, setAttempt] = useState(0);
  const viewId = useId();
  const sessionId = `${viewId}:${attempt}`;
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const nativeRef = useRef<WebView>(null);
  useImperativeHandle(ref, () => nativeRef.current!, [attempt]);
  const callbacks = useRef({ onMessage, onInitializationError });
  callbacks.current = { onMessage, onInitializationError };
  const prepared = useMemo(() => {
    const script = `window.__jojoReaderSessionId = ${JSON.stringify(sessionId)};\n${initial.bootstrapScript}`;
    return { script, source: { html: initial.html.replace("</body>", () => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script></body>`) }, ready: false, page: false };
  }, [initial, sessionId]);

  useLayoutEffect(() => {
    activeSession.current = sessionId;
    const waiting = () => activeSession.current === sessionId && !(prepared.ready && prepared.page);
    // Start before any native load callback: onLoadEnd itself can be missing.
    const retryScript = setTimeout(() => {
      if (waiting()) nativeRef.current?.injectJavaScript(prepared.script);
    }, 3_000);
    const recover = setTimeout(() => {
      if (!waiting()) return;
      if (attempt === 0) setAttempt(1);
      else callbacks.current.onInitializationError();
    }, 6_000);
    return () => {
      clearTimeout(retryScript);
      clearTimeout(recover);
      if (activeSession.current === sessionId) activeSession.current = "";
    };
  }, [attempt, prepared, sessionId]);

  return <WebView {...props}
    key={sessionId}
    ref={nativeRef}
    source={prepared.source}
    injectedJavaScript={prepared.script}
    onLoadEnd={(event) => {
      if (activeSession.current !== sessionId) return;
      nativeRef.current?.injectJavaScript(prepared.script);
      onLoadEnd?.(event);
    }}
    onMessage={(event) => {
      if (activeSession.current !== sessionId) return;
      try {
        if (JSON.parse(event.nativeEvent.data).readerSessionId !== sessionId) return;
      } catch { return; }
      const message = parseBookReaderMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "reader-ready") prepared.ready = true;
      if (message.type === "reader-page") prepared.page = true;
      callbacks.current.onMessage?.(event);
    }}
  />;
}
