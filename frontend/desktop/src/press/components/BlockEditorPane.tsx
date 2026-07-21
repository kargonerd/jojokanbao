
import type { ProofreadBlock, ProofreadBlockKind, ProofreadFontWeight } from '../types/issues';
import { PressButton, PressWorkbenchPanel } from './PressUi';

interface BlockEditorPaneProps {
  block: ProofreadBlock;
  text: string;
  onTextChange: (value: string) => void;
  onSave: () => void;
  onToggleChecked?: () => void;
  onKindChange?: (value: ProofreadBlockKind) => void;
  onFontSizeChange?: (value: number) => void;
  onFontWeightChange?: (value: ProofreadFontWeight) => void;
  autosaveMessage?: string;
  saveLabel?: string;
}

export function BlockEditorPane({
  block,
  text,
  onTextChange,
  onSave,
  onToggleChecked,
  onKindChange,
  onFontSizeChange,
  onFontWeightChange,
  autosaveMessage,
  saveLabel = '保存当前修改'
}: BlockEditorPaneProps) {
  return (
    <PressWorkbenchPanel title="文字编辑" meta={block.label ?? block.id} className="workbench-panel--editor" labelledBy="block-editor-heading">
      <label className="form-group" htmlFor="proofread-block-text">
        <span>文字内容</span>
        <textarea id="proofread-block-text" value={text} onChange={(event) => onTextChange(event.target.value)} rows={10} />
      </label>

      <details className="editor-format">
        <summary>格式</summary>
        <div className="editor-grid">
          <label className="form-group">
            <span>块类型</span>
            <select value={block.kind ?? 'body'} onChange={(event) => onKindChange?.(event.target.value as ProofreadBlockKind)}>
              <option value="heading">标题</option>
              <option value="body">正文</option>
              <option value="footnote">脚注</option>
              <option value="caption">图注</option>
            </select>
          </label>

          <label className="form-group">
            <span>字号</span>
            <input
              type="range"
              min="10"
              max="32"
              value={block.fontSize ?? 14}
              onChange={(event) => onFontSizeChange?.(Number(event.target.value))}
            />
          </label>

          <label className="form-group">
            <span>粗细</span>
            <select value={block.fontWeight ?? 'regular'} onChange={(event) => onFontWeightChange?.(event.target.value as ProofreadFontWeight)}>
              <option value="regular">Regular</option>
              <option value="medium">Medium</option>
              <option value="bold">Bold</option>
            </select>
          </label>
        </div>
      </details>

      <div className="editor-actions">
        <PressButton type="button" onClick={onSave}>
          {saveLabel}
        </PressButton>
        <PressButton tone="secondary" type="button" onClick={onToggleChecked}>
          标记无误
        </PressButton>
      </div>

      {autosaveMessage ? <p className="autosave-indicator">{autosaveMessage}</p> : null}
    </PressWorkbenchPanel>
  );
}
