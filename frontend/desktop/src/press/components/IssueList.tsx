
import type { ProofreadBlock, ProofreadIssue } from '../types/issues';
import { PressWorkbenchPanel } from './PressUi';

interface IssueListProps {
  issues: ProofreadIssue[];
  blocks: ProofreadBlock[];
  selectedBlockId?: string | null;
  onSelectBlock?: (blockId: string) => void;
  title?: string;
  meta?: string;
}

export function IssueList({ issues, blocks, selectedBlockId, onSelectBlock, title = '待校对', meta }: IssueListProps) {
  return (
    <PressWorkbenchPanel title={title} meta={meta ?? `${issues.length} 条待看`} labelledBy="issue-queue-heading">
      <ul className="issue-list">
        {blocks.map((block) => {
          const relatedIssue = issues.find((issue) => issue.blockId === block.id);
          const isSelected = selectedBlockId === block.id;

          return (
            <li key={block.id}>
              <button
                className={`issue-list__item ${isSelected ? 'issue-list__item--selected' : ''}`}
                type="button"
                onClick={() => onSelectBlock?.(block.id)}
              >
                <span className="issue-list__label">{block.label ?? block.id}</span>
                <span className="issue-list__meta">{block.checked ? '已确认' : relatedIssue?.message ?? '待确认'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </PressWorkbenchPanel>
  );
}
