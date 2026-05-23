import { useParams } from "react-router-dom";
import { useState } from "react";
import { usePdfDocument, PdfPage } from "@jojo/pdf-viewer";
import { Button, LoadingSpinner } from "@jojo/ui";

export function ProofreadPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(2);

  // In real app, PDF URL comes from project data via IPC
  const pdfUrl = `/public/test.pdf`;
  const { document: pdfDoc, loading, error, numPages } = usePdfDocument({ url: pdfUrl });

  if (loading) return <LoadingSpinner text="加载 PDF 中" fullscreen />;
  if (error) return <div className="p-8 text-center text-muted">PDF 加载失败: {error}</div>;

  return (
    <div className="h-screen flex flex-col bg-paper">
      {/* Toolbar */}
      <header className="h-12 flex items-center gap-4 px-4 border-b border-rule shrink-0">
        <span className="text-sm font-bold text-ink">校对</span>
        <span className="text-xs text-muted">项目 {projectId}</span>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} className="text-sm font-bold text-ink border-0 bg-transparent disabled:opacity-30 cursor-pointer">‹</button>
          <span className="text-xs text-muted">{currentPage} / {numPages}</span>
          <button onClick={() => setCurrentPage(Math.min(numPages, currentPage + 1))} disabled={currentPage >= numPages} className="text-sm font-bold text-ink border-0 bg-transparent disabled:opacity-30 cursor-pointer">›</button>
          <input type="range" min="1" max="4" value={scale} onChange={(e) => setScale(+e.target.value)} className="w-16 accent-[var(--color-red)]" />
        </div>
      </header>

      {/* PDF + Overlay */}
      <main className="flex-1 overflow-auto p-4">
        {pdfDoc && (
          <div className="relative max-w-4xl mx-auto">
            <PdfPage document={pdfDoc} pageNumber={currentPage} scale={scale} />
            {/* TODO: Bbox overlay layer for proofread annotations */}
          </div>
        )}
      </main>
    </div>
  );
}
