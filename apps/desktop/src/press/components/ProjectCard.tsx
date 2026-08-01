
import type { MockTaskSummary } from '../types/project';
import { PressActionLink } from './PressUi';

interface ProjectCardProps {
  task: MockTaskSummary;
}

export function ProjectCard({ task }: ProjectCardProps) {
  return (
    <article className={`task-card task-card--${task.tone}`}>
      <div className="task-card__topline">
        <span className="task-card__step">{task.currentStep}</span>
        <span className="task-card__updated">{task.updatedAt}</span>
      </div>
      <h3 className="task-card__title">{task.title}</h3>
      <p className="task-card__summary">{task.progressLabel}</p>
      <div className="task-card__progress" aria-label={`${task.title} 进度 ${task.progressPercent}%`}>
        <div className="task-card__progress-bar">
          <div className="task-card__progress-fill" style={{ width: `${task.progressPercent}%` }} />
        </div>
        <span className="task-card__progress-text">{task.progressPercent}%</span>
      </div>
      <PressActionLink className="task-card__action" to={task.nextHref}>
        {task.ctaLabel}
      </PressActionLink>
    </article>
  );
}
