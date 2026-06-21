
import { getStageLabel } from '../lib/operatorDisplay';
import { PressPanel } from './PressUi';

interface StageSummaryProps {
  currentStage: string;
}

export function StageSummary({ currentStage }: StageSummaryProps) {
  return (
    <PressPanel title="当前步骤">
      <p className="stage-pill">{getStageLabel(currentStage)}</p>
    </PressPanel>
  );
}
