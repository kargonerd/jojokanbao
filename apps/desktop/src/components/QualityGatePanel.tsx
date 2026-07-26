
import { PressPanel } from './PressUi';

interface QualityGatePanelProps {
  status: 'blocked' | 'passed';
  checks: string[];
}

export function QualityGatePanel({ status, checks }: QualityGatePanelProps) {
  const blocked = status === 'blocked';

  return (
    <PressPanel title="检查结果" labelledBy="quality-gate-heading">
      <p className="section-description">
        {blocked ? '当前还不能导出，请先处理下面的问题。' : '检查已经通过，可以继续导出。'}
      </p>
      <ul className="stack-list">
        {checks.map((check) => (
          <li key={check}>{check}</li>
        ))}
      </ul>
      <p className="section-description">
        {blocked ? '全部处理完成后，再回到这里确认可以导出。' : '现在可以进入导出步骤。'}
      </p>
    </PressPanel>
  );
}

export default QualityGatePanel;
