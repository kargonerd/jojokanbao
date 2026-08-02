import { useEffect, useMemo, useState } from 'react';
import '../lib/pdfjsCompat';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

import { BlockEditorPane } from '../components/BlockEditorPane';
import { IssueList } from '../components/IssueList';
import { PressActionLink, PressPage, PressWorkbenchPanel } from '../components/PressUi';
import type { ProofreadBlock, ProofreadBlockKind, ProofreadFontWeight, ProofreadWorkspace } from '../types/issues';
import { pressPath } from '../paths';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

interface ProofreadIssuesPageProps {
  projectId?: string;
  workspace: ProofreadWorkspace;
  onSaveBlock?: (payload: { blockId: string; text: string }) => Promise<void> | void;
}

function createUpdatedBlock(block: ProofreadBlock, patch: Partial<ProofreadBlock>) {
  return { ...block, ...patch };
}

function getInitialBlocks(workspace: ProofreadWorkspace) {
  if (workspace.blocks?.length) {
    return workspace.blocks;
  }

  return workspace.block ? [workspace.block] : [];
}

function getPreviewBBoxStyle(bbox?: ProofreadBlock['bbox'], viewport?: { width: number; height: number } | null) {
  if (!bbox) {
    return {
      left: '0%',
      top: '0%',
      width: '0%',
      height: '0%'
    };
  }

  const useMineruScale = Math.max(bbox.x ?? 0, bbox.y ?? 0, bbox.width ?? 0, bbox.height ?? 0) > 100;

  if (viewport) {
    const scale = useMineruScale ? 1000 : 100;
    return {
      left: `${((bbox.x ?? 0) / scale) * viewport.width}px`,
      top: `${((bbox.y ?? 0) / scale) * viewport.height}px`,
      width: `${((bbox.width ?? 0) / scale) * viewport.width}px`,
      height: `${((bbox.height ?? 0) / scale) * viewport.height}px`
    };
  }

  const scale = useMineruScale ? 10 : 1;

  return {
    left: `${(bbox.x ?? 0) / scale}%`,
    top: `${(bbox.y ?? 0) / scale}%`,
    width: `${(bbox.width ?? 0) / scale}%`,
    height: `${(bbox.height ?? 0) / scale}%`
  };
}

export function ProofreadIssuesPage({ projectId = 'mock-1', workspace, onSaveBlock }: ProofreadIssuesPageProps) {
  const [blocks, setBlocks] = useState(getInitialBlocks(workspace));
  const [selectedBlockId, setSelectedBlockId] = useState(workspace.selectedBlockId ?? workspace.block?.id ?? getInitialBlocks(workspace)[0]?.id ?? null);
  const [autosaveMessage, setAutosaveMessage] = useState(workspace.autosave?.message ?? '');

  useEffect(() => {
    const nextBlocks = getInitialBlocks(workspace);
    setBlocks(nextBlocks);
    setSelectedBlockId(workspace.selectedBlockId ?? workspace.block?.id ?? nextBlocks[0]?.id ?? null);
    setAutosaveMessage(workspace.autosave?.message ?? '');
  }, [workspace]);

  const selectedBlock = useMemo(
    () => blocks.find((block) => block.id === selectedBlockId) ?? blocks[0] ?? workspace.block,
    [blocks, selectedBlockId, workspace.block]
  );

  const handlePatchBlock = (patch: Partial<ProofreadBlock>) => {
    if (!selectedBlock) {
      return;
    }

    setBlocks((current) => current.map((block) => (block.id === selectedBlock.id ? createUpdatedBlock(block, patch) : block)));
    setAutosaveMessage('当前修改已暂存，点击保存后写入项目。');
  };

  const handleSave = async () => {
    if (!selectedBlock) {
      return;
    }

    await onSaveBlock?.({
      blockId: selectedBlock.id,
      text: selectedBlock.text
    });
    setAutosaveMessage('当前文字已保存。请继续检查下一处，或确认本页已经校对完成。');
  };

  const checkedCount = workspace.checkedCount ?? blocks.filter((block) => block.checked).length;
  const totalBlocks = workspace.totalBlocks ?? blocks.length;
  const previewPage = workspace.preview.page;
  const totalPages = workspace.preview.totalPages ?? workspace.preview.pages?.length;
  const previewDocumentUrl = workspace.preview.documentUrl || undefined;
  const previewUrl = previewDocumentUrl ? `${previewDocumentUrl}#page=${previewPage}` : undefined;
  const previewPageData = workspace.preview.pages?.find((page) => page.pageNum === previewPage);
  const previewBlocks = previewPageData?.blocks ?? [];
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [previewViewport, setPreviewViewport] = useState<{ width: number; height: number } | null>(null);
  const [previewRenderFailed, setPreviewRenderFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!previewDocumentUrl) {
      setPreviewImageSrc(null);
      setPreviewViewport(null);
      setPreviewRenderFailed(false);
      return () => {
        cancelled = true;
      };
    }

    setPreviewImageSrc(null);
    setPreviewViewport(null);
    setPreviewRenderFailed(false);

    void (async () => {
      try {
        const response = await fetch(previewDocumentUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`failed to fetch preview pdf: ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const documentTask = getDocument({ data, disableWorker: true } as Parameters<typeof getDocument>[0]);
        const pdf = await documentTask.promise;
        const page = await pdf.getPage(previewPage);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (!context) {
          throw new Error('canvas context unavailable');
        }

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: context, viewport }).promise;

        if (!cancelled) {
          setPreviewViewport({ width: viewport.width, height: viewport.height });
          setPreviewImageSrc(canvas.toDataURL('image/png'));
          setPreviewRenderFailed(false);
        }
      } catch (error) {
        console.error('Failed to render proofread PDF preview', error);
        if (!cancelled) {
          setPreviewImageSrc(null);
          setPreviewViewport(null);
          setPreviewRenderFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewDocumentUrl, previewPage]);

  return (
    <PressPage
      title="文字和格式校对"
      description={undefined}
      projectId={projectId}
      activeStep="proofread"
      full
      split
      projectMeta={
        <>
          {workspace.documentTitle ? <strong>{workspace.documentTitle}</strong> : null}
          <span>{totalPages ? `第 ${previewPage} / ${totalPages} 页` : `第 ${previewPage} 页`} · {previewBlocks.length} 个文本块</span>
        </>
      }
    >
      <section className="proofread-layout">
        <aside className="proofread-layout__sidebar">
          {workspace.status === 'recognition_pending' ? null : (
            <IssueList
              issues={workspace.issues}
              blocks={blocks}
              selectedBlockId={selectedBlock?.id}
              onSelectBlock={setSelectedBlockId}
              meta={`${checkedCount} / ${totalBlocks}`}
            />
          )}
        </aside>

        <PressWorkbenchPanel title="页面预览" meta={`第 ${previewPage} 页`} className="workbench-panel--preview">
          {previewUrl || previewBlocks.length ? (
            <div
              className="page-canvas"
              style={previewViewport ? { width: `${previewViewport.width}px`, minHeight: `${previewViewport.height}px`, height: `${previewViewport.height}px` } : undefined}
            >
              {previewImageSrc ? <img className="pdf-preview-frame" alt={`第 ${previewPage} 页预览`} src={previewImageSrc} /> : null}
              {!previewImageSrc && previewRenderFailed && previewUrl ? <iframe className="pdf-preview-frame pdf-preview-frame--fallback" title={`第 ${previewPage} 页预览`} src={previewUrl} /> : null}
              {previewBlocks.map((block) => {
                const isSelected = block.id === selectedBlock?.id;
                return (
                  <button
                    key={block.id ?? `${block.type}-${block.text}`}
                    type="button"
                    aria-label={`${block.id ?? block.text} bbox`}
                    className={`page-canvas__bbox${isSelected ? ' page-canvas__bbox--selected' : ''}`}
                    style={getPreviewBBoxStyle(block.bbox, previewViewport)}
                    onClick={() => block.id && setSelectedBlockId(block.id)}
                  >
                    <span>{block.text}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="page-canvas">暂无可用预览</div>
          )}

          {workspace.notice ? <p role="alert">{workspace.notice}</p> : null}

          {workspace.status !== 'recognition_pending' ? (
            <div className="preview-footer">
              <PressActionLink to={pressPath(`/projects/${projectId}/export`)}>
                进入导出
              </PressActionLink>
            </div>
          ) : null}
        </PressWorkbenchPanel>

        {workspace.status !== 'recognition_pending' && selectedBlock ? (
          <BlockEditorPane
            block={selectedBlock}
            text={selectedBlock.text}
            onTextChange={(value) => handlePatchBlock({ text: value })}
            onSave={handleSave}
            onToggleChecked={() => handlePatchBlock({ checked: true })}
            onKindChange={(value: ProofreadBlockKind) => handlePatchBlock({ kind: value })}
            onFontSizeChange={(value) => handlePatchBlock({ fontSize: value })}
            onFontWeightChange={(value: ProofreadFontWeight) => handlePatchBlock({ fontWeight: value })}
            autosaveMessage={autosaveMessage}
            saveLabel="保存并继续"
          />
        ) : null}
      </section>
    </PressPage>
  );
}

export default ProofreadIssuesPage;
