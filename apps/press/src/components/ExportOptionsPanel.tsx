
import { getExportOptionLabel } from '../lib/operatorDisplay';
import type { ExportOption } from '../types/project';
import { PressButton, PressPanel } from './PressUi';

interface ExportOptionsPanelProps {
  options: ExportOption[];
  onSelect?: (optionId: string) => void;
}

export function ExportOptionsPanel({ options, onSelect }: ExportOptionsPanelProps) {
  return (
    <PressPanel title="导出选项" labelledBy="export-options-heading">
      <div className="button-row">
        {options.map((option) => (
          <PressButton key={option.id} tone="secondary" type="button" onClick={() => onSelect?.(option.id)}>
            {getExportOptionLabel(option.label)}
          </PressButton>
        ))}
      </div>
    </PressPanel>
  );
}

export default ExportOptionsPanel;
