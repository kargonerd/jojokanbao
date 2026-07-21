import { useState } from 'react';

import type { PdfPreviewData } from '../types/issues';
import { PressButton, PressPanel } from './PressUi';

interface PdfPreviewPaneProps {
  preview: PdfPreviewData | null;
}

export function PdfPreviewPane({ preview }: PdfPreviewPaneProps) {
  const [currentPage, setCurrentPage] = useState(1);

  if (!preview) {
    return (
      <PressPanel title="页面预览" labelledBy="pdf-preview-heading">
        <p className="section-description">暂无预览</p>
        <div className="pdf-preview-frame pdf-preview-frame--empty">
          <span>PDF 预览不可用</span>
        </div>
      </PressPanel>
    );
  }

  const pages = preview.pages || [];
  const totalPages = preview.totalPages || pages.length || 0;
  const pageIndex = Math.min(currentPage - 1, pages.length - 1);
  const currentPageData = pages[pageIndex];

  return (
    <PressPanel title="页面预览" labelledBy="pdf-preview-heading">
      <p className="section-description">
        第 {currentPage} 页{totalPages > 0 && ` / 共 ${totalPages} 页`}
      </p>

      {totalPages > 1 ? (
        <div className="button-row">
          <PressButton tone="secondary" type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1}>
            上一页
          </PressButton>
          <span>第 {currentPage} 页</span>
          <PressButton tone="secondary" type="button" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage >= totalPages}>
            下一页
          </PressButton>
        </div>
      ) : null}

      <div className="pdf-preview-frame pdf-preview-frame--text">
        {currentPageData?.content ? currentPageData.content : preview.fullText ? preview.fullText : <span>暂无内容</span>}
      </div>
    </PressPanel>
  );
}
