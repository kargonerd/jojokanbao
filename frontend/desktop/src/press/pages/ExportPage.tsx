import { useState } from 'react';

import { PressActionLink, PressButton, PressPage, PressPanel } from '../components/PressUi';
import { getExportOptionLabel } from '../lib/operatorDisplay';
import type { ExportOption, MockExportPlan } from '../types/project';
import { pressPath } from '../paths';

interface ExportPageProps {
  options?: ExportOption[];
  onExport?: (optionId: string) => Promise<{ path: string }> | { path: string };
  plan?: MockExportPlan;
  projectId?: string;
}

export function ExportPage({ options, onExport, plan, projectId }: ExportPageProps) {
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const sortedOptions = options ?? [];

  if (plan) {
    return (
      <PressPage title="导出" description={undefined} compact projectId={projectId} activeStep="export">
        <section className="page-layout page-layout--single">
          <PressPanel title={plan.title} meta={`目标：${plan.destination}`}>
            <div className="structured-grid">
              {plan.targets.map((target) => (
                <section key={target.id} className={`structured-card ${target.primary ? 'structured-card--primary' : ''}`}>
                  <h3>{target.label}</h3>
                  <p>{target.description}</p>
                </section>
              ))}
            </div>

            <div className="inline-actions">
              <PressActionLink tone="secondary" to={pressPath(`/projects/${projectId ?? 'mock-1'}/structured`)}>
                返回导出准备
              </PressActionLink>
              <PressButton type="button" onClick={() => setExportedPath(plan.destination)}>
                生成导出文件
              </PressButton>
            </div>

            {exportedPath ? <p className="status-pill status-pill--success">导出完成：{exportedPath}</p> : null}
          </PressPanel>
        </section>
      </PressPage>
    );
  }

  return (
    <PressPage
      title="导出"
      description={undefined}
      compact
      projectId={projectId}
      activeStep="export"
    >
      <section className="page-layout page-layout--single">
        <PressPanel title="可用格式" meta={`${sortedOptions.length} 种`} className="export-panel">
          <div className="export-actions">
            {sortedOptions.map((option) => (
              <PressButton
                key={option.id}
                type="button"
                className={`export-action export-action--${option.id}`}
                onClick={async () => {
                  const result = await onExport?.(option.id);
                  if (result?.path) {
                    setExportedPath(result.path);
                  }
                }}
              >
                {getExportOptionLabel(option.label)}
              </PressButton>
            ))}
          </div>

          {exportedPath ? <p className="export-result">导出完成：{exportedPath}</p> : null}
        </PressPanel>
      </section>
    </PressPage>
  );
}

export default ExportPage;
