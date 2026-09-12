import { useState, type Ref } from "react";
import { WebView, type WebViewProps } from "react-native-webview";

type Props = Omit<WebViewProps, "source" | "injectedJavaScript"> & {
  ref?: Ref<WebView>;
  html: string;
  bootstrapScript: string;
};

export function BookReaderWebView({ html, bootstrapScript, ...props }: Props) {
  // The parent remounts this view for a new chapter or display setting. Saved
  // progress and other React updates must not reload the current document.
  const [source] = useState(() => ({
    html: html.replace("</body>", () => `<script>${bootstrapScript.replace(/<\/script/gi, "<\\/script")}</script></body>`),
  }));
  return <WebView {...props} source={source} injectedJavaScript={bootstrapScript} />;
}
