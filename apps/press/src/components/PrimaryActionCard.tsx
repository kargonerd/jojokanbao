import { PressActionLink, PressPanel } from './PressUi';

interface PrimaryActionCardProps {
  actionLabel: string;
  actionHref: string;
}

export function PrimaryActionCard({ actionLabel, actionHref }: PrimaryActionCardProps) {
  return (
    <PressPanel title="下一步">
      <p className="section-description">先完成当前步骤，再继续后面的流程。</p>
      <PressActionLink to={actionHref}>
        {actionLabel}
      </PressActionLink>
    </PressPanel>
  );
}
