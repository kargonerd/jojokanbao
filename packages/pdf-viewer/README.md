# @jojo/pdf-viewer

共享 PDF 渲染组件，封装 pdfjs-dist。

## API

### `usePdfDocument({ url })`

加载 PDF 文档，返回 `{ document, numPages, loading, error }`。

### `<PdfPage document={doc} pageNumber={1} />`

渲染单页到 canvas，默认按显示宽度和设备像素比自动选择安全分辨率；可用 `quality` 提高清晰度，带加载指示器。

### `<PdfViewer document={doc} />`

多页查看器，支持按真实页面比例占位、IntersectionObserver 懒加载和远页 canvas 回收。

可选传入 `zoomEnabled`、`zoom` 和 `onZoomChange` 开启 PDF 区域原地缩放；点击放大、Shift+点击缩小，放大后可用鼠标或触控拖动查看。

## 使用

```tsx
import { usePdfDocument, PdfViewer } from "@jojo/pdf-viewer";

function MyReader() {
  const { document, loading } = usePdfDocument({ url: "/path/to/file.pdf" });
  if (loading) return <p>加载中...</p>;
  if (!document) return <p>加载失败</p>;
  return <PdfViewer document={document} />;
}
```

## 注意

- 测试环境需要 mock pdfjs-dist（jsdom 不支持 DOMMatrix/Canvas）
- `quality` 表示相对显示尺寸的输出像素倍率，当前阅读器使用 1–3 档且默认最高档 3；画布仍受 3200 万像素和 8192 单边上限保护
- 可选 `scale` 会覆盖自动分辨率，但仍受 canvas 像素和边长上限保护
- Reader 构建会把 cmap、wasm 和 standard fonts 复制到 `/assets/pdfjs/`，运行时不依赖第三方 CDN
