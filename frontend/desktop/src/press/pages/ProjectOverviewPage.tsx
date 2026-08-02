import { useLoaderData } from 'react-router-dom';

import { PressActionLink, PressPage, PressPanel } from '../components/PressUi';
import type { ProjectOverview } from '../types/project';
import { isProofreadStage } from '../lib/operatorDisplay';
import { pressPath } from '../paths';

interface ProjectOverviewPageProps {
  project?: ProjectOverview;
}

function resolveProject(project?: ProjectOverview) {
  if (project) {
    return project;
  }

  return useLoaderData() as ProjectOverview;
}

export default function ProjectOverviewPage({ project }: ProjectOverviewPageProps) {
  const currentProject = resolveProject(project);
  const proofreadStage = isProofreadStage(currentProject.currentStage);
  const nextHref = pressPath(
    proofreadStage
      ? `/projects/${currentProject.id}/proofread`
      : `/projects/${currentProject.id}/metadata`,
  );
  const nextLabel = proofreadStage ? '继续校对' : '检查识别结果';
  const summary = proofreadStage
    ? '请对照扫描页检查识别文字，修改后保存。'
    : '请先检查书名、作者、语言和封面信息，确认无误后再进入校对。';

  return (
    <PressPage
      title={currentProject.title}
      description={`当前阶段：${currentProject.currentStage}`}
      projectId={currentProject.id}
      activeStep="overview"
    >
      <PressPanel title="当前步骤">
        <p>{summary}</p>
        <PressActionLink to={nextHref} preserveVariant={false}>
          {nextLabel}
        </PressActionLink>
      </PressPanel>
    </PressPage>
  );
}
