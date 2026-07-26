
import type { TocTreeItem } from '../types/issues';
import { PressPanel } from './PressUi';

interface TocTreeEditorProps {
  items: TocTreeItem[];
}

export function TocTreeEditor({ items }: TocTreeEditorProps) {
  return (
    <PressPanel title="目录结构" labelledBy="toc-tree-editor-heading">
      <ul className="stack-list">
        {items.map((item) => (
          <li key={item.id}>{item.label}</li>
        ))}
      </ul>
    </PressPanel>
  );
}
