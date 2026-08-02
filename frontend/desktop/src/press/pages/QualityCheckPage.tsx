
import { PressActionLink, PressPage, PressPanel, PressStageStrip } from '../components/PressUi';
import type { MockStructuredOutputPreview, QualityStatus } from '../types/project';
import { pressPath } from '../paths';

interface QualityCheckPageProps {
  quality: QualityStatus | MockStructuredOutputPreview;
  projectId?: string;
}

function isMockQuality(quality: QualityStatus | MockStructuredOutputPreview): quality is MockStructuredOutputPreview {
  return 'summary' in quality;
}

export function QualityCheckPage({ quality, projectId }: QualityCheckPageProps) {
  if (isMockQuality(quality)) {
    return (
      <PressPage title="结构化结果" description="校对后的数据会被组织为书籍元数据、目录、标题、正文和脚注，然后进入 EPUB 导出。" projectId={projectId} activeStep="export">
        {projectId ? null : <PressStageStrip active="export" />}

        <section className="page-layout page-layout--single">
          <PressPanel title={quality.title} meta="已生成结构化结果">
            <ul className="summary-list">
              {quality.summary.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <div className="structured-grid">
              {quality.sections.map((section) => (
                <section key={section.id} className="structured-card">
                  <h3>{section.label}</h3>
                  <strong>{section.count}</strong>
                  <p>{section.description}</p>
                </section>
              ))}
            </div>

            <div className="inline-actions">
              <PressActionLink tone="secondary" to={pressPath('/projects/mock-1/proofread')}>
                返回校对台
              </PressActionLink>
              <PressActionLink to={quality.exportHref}>
                进入 EPUB 导出
              </PressActionLink>
            </div>
          </PressPanel>
        </section>
      </PressPage>
    );
  }

  const blocked = quality.status === 'blocked';

  return (
    <PressPage title="质量检查" description="先确认当前项目是否已经满足导出条件。" projectId={projectId} activeStep="export">
      {projectId ? null : <PressStageStrip active="export" />}

      <section className="page-layout page-layout--single">
        <PressPanel title="检查结果" meta={blocked ? '存在待处理问题' : '可以继续导出'}>
          <p>{blocked ? '当前还不能导出，请先处理下面的问题。' : '全部检查已经通过，可以进入导出。'}</p>
          <ul className="summary-list">
            {quality.checks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>{blocked ? '全部处理完成后，再回到这里确认可以导出。' : '确认无误后，继续到导出页面生成文件。'}</p>
        </PressPanel>
      </section>
    </PressPage>
  );
}

export default QualityCheckPage;
