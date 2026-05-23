# @jojo/pdf-viewer

共享 PDF 渲染组件，封装 pdfjs-dist。

## API

### `usePdfDocument({ url })`

加载 PDF 文档，返回 `{ document, numPages, loading, error }`。

### `<PdfPage document={doc} pageNumber={1} scale={2} />`

渲染单页到 canvas，带加载指示器。

### `<PdfViewer document={doc} scale={2} />`

多页查看器，支持 IntersectionObserver 懒加载。

## 使用

```tsx
import { usePdfDocument, PdfViewer } from "@jojo/pdf-viewer";

function MyReader() {
  const { document, loading } = usePdfDocument({ url: "/path/to/file.pdf" });
  if (loading) return <p>加载中...</p>;
  if (!document) return <p>加载失败</p>;
  return <PdfViewer document={document} scale={2} />;
}
```

## 注意

- 测试环境需要 mock pdfjs-dist（jsdom 不支持 DOMMatrix/Canvas）
- cmap 默认从 unpkg CDN 加载，生产环境建议本地托管
