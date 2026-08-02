import { useEffect, useState } from 'react';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { PressActionLink, PressButton, PressPage, PressPanel } from '../components/PressUi';
import { ProjectCard } from '../components/ProjectCard';
import { VariantLink } from '../components/VariantLink';
import { useMockVariant } from '../mock/variant-context';
import { pressPath } from '../paths';
import type { MockTaskSummary } from '../types/project';

type CreateProjectPhase = 'selecting' | 'creating';
type CreateProjectResult = { status: 'created' | 'cancelled' | 'error' | 'mineru_not_configured' };

type ProjectListEntry = {
  id: string;
  title: string;
  currentStage: string;
  nextHref: string;
  createdAt?: string | null;
  pdfUrl?: string | null;
  coverUrl?: string | null;
};

interface ProjectListPageProps {
  engineStatus?: string;
  projects?: ProjectListEntry[];
  onCreateProject?: (onPhaseChange: (phase: CreateProjectPhase) => void) => Promise<CreateProjectResult>;
  mockTasks?: MockTaskSummary[];
}

interface NewProjectPageProps {
  onCreateProject?: (onPhaseChange: (phase: CreateProjectPhase) => void) => Promise<CreateProjectResult>;
}

const DEFAULT_PROJECT_COVER = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320">
  <rect width="240" height="320" fill="#efe5d6"/>
  <rect x="26" y="26" width="188" height="268" fill="#f8f3ea" stroke="#8b1a1a" stroke-width="3"/>
  <rect x="52" y="72" width="136" height="16" fill="#8b1a1a"/>
  <rect x="52" y="104" width="116" height="12" fill="#d8cbb6"/>
  <rect x="52" y="132" width="92" height="12" fill="#d8cbb6"/>
  <rect x="52" y="196" width="136" height="70" fill="#e7dac7"/>
  <text x="120" y="238" font-size="18" text-anchor="middle" fill="#7f6a4c" font-family="sans-serif">PDF</text>
</svg>
`)}`;

function isImageUrl(url: string) {
  return /^data:image\//.test(url) || /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(url);
}

function ProjectCoverPreview({ title, coverUrl, pdfUrl }: { title: string; coverUrl?: string | null; pdfUrl?: string | null }) {
  const [imageSrc, setImageSrc] = useState<string | null>(coverUrl && isImageUrl(coverUrl) ? coverUrl : null);

  useEffect(() => {
    let cancelled = false;

    if (coverUrl && isImageUrl(coverUrl)) {
      setImageSrc(coverUrl);
      return () => {
        cancelled = true;
      };
    }

    if (!pdfUrl) {
      setImageSrc(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const documentTask = getDocument({ url: pdfUrl, disableWorker: true } as Parameters<typeof getDocument>[0]);
        const pdf = await documentTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.28 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (!context) {
          throw new Error('canvas context unavailable');
        }

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: context, viewport }).promise;

        if (!cancelled) {
          setImageSrc(canvas.toDataURL('image/png'));
        }
      } catch {
        if (!cancelled) {
          setImageSrc(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [coverUrl, pdfUrl]);

  const resolvedImageSrc = imageSrc ?? DEFAULT_PROJECT_COVER;
  const alt = imageSrc ? `${title} 封面预览` : `${title} 默认封面`;

  return <img className="project-card__cover" src={resolvedImageSrc} alt={alt} />;
}

function RealProjectCard({ project }: { project: ProjectListEntry }) {
  return (
    <VariantLink className="bookshelf-card" to={project.nextHref} aria-label={`${project.title} ${project.currentStage}`}>
      <div className="bookshelf-card__cover-frame">
        <ProjectCoverPreview title={project.title} coverUrl={project.coverUrl} pdfUrl={project.pdfUrl} />
        <span className="project-card__status-badge">{project.currentStage}</span>
      </div>
      <div className="bookshelf-card__meta">
        <h3 className="bookshelf-card__title" title={project.title}>
          {project.title}
        </h3>
      </div>
    </VariantLink>
  );
}

function useCreateProjectStatus(onCreateProject?: (onPhaseChange: (phase: CreateProjectPhase) => void) => Promise<CreateProjectResult>) {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [workingMessage, setWorkingMessage] = useState<string | null>(null);

  const handleCreateProject = async () => {
    setStatusMessage(null);
    setWorkingMessage('正在打开文件选择器…');

    const result = await onCreateProject?.((phase) => {
      setWorkingMessage(phase === 'selecting' ? '正在打开文件选择器…' : '正在创建项目…');
    });

    if (!result) {
      return;
    }

    if (result.status === 'cancelled') {
      setWorkingMessage(null);
      setStatusMessage('未选择文件，操作已取消');
      return;
    }

    if (result.status === 'mineru_not_configured') {
      setWorkingMessage(null);
      setStatusMessage('识别服务未配置：请配置 MinerU API 后重试');
      return;
    }

    if (result.status === 'error') {
      setWorkingMessage('正在创建项目…');
      setStatusMessage('创建项目失败，请重试');
      return;
    }

    setWorkingMessage('正在创建项目…');
  };

  return { statusMessage, workingMessage, handleCreateProject };
}

export function NewProjectPage({ onCreateProject }: NewProjectPageProps) {
  const { statusMessage, workingMessage, handleCreateProject } = useCreateProjectStatus(onCreateProject);

  return (
    <PressPage
      title="新建项目"
      description="选择一个 PDF 文件，系统会创建项目并立即进入识别。"
      home
      compact
      split
      actions={<PressActionLink tone="secondary" to={pressPath()}>返回项目列表</PressActionLink>}
    >
      {workingMessage || statusMessage ? (
        <div className="status-stack">
          {workingMessage ? <p>{workingMessage}</p> : null}
          {statusMessage ? <p>{statusMessage}</p> : null}
        </div>
      ) : null}

      <section className="page-layout page-layout--single">
        <PressPanel title="上传 PDF" className="panel--primary-action panel--upload-entry" as="section">
          <p>支持从本地选择 PDF。识别开始后会自动进入下一步。</p>
          <div className="upload-dropzone">
            <p>请选择一个 PDF 文件，系统会自动创建项目并开始处理。</p>
            <div className="inline-actions">
              <PressButton type="button" onClick={() => void handleCreateProject()}>
                选择 PDF 文件
              </PressButton>
            </div>
          </div>
        </PressPanel>
      </section>
    </PressPage>
  );
}

export default function ProjectListPage({ engineStatus = '正常', projects, onCreateProject, mockTasks = [] }: ProjectListPageProps) {
  const { variant, variants, setVariant } = useMockVariant();
  const realMode = projects !== undefined;
  const realProjects = projects ?? [];
  void engineStatus;
  void onCreateProject;

  if (realMode) {
    return (
      <PressPage
        title="我的项目"
        description="将扫描版 PDF 转换为可编辑、可导出的结构化书籍数据"
        home
        compact
        split
        actions={<PressActionLink to={pressPath('/projects/new')}>新建项目</PressActionLink>}
      >
        <section className="page-layout page-layout--single">
          <PressPanel className="panel--project-list panel--bookshelf" as="section">
            <div className="task-list task-list--scrollable task-list--bookshelf">
              {realProjects.map((project) => (
                <RealProjectCard key={project.id} project={project} />
              ))}
            </div>
            {realProjects.length === 0 ? <p>还没有项目</p> : null}
          </PressPanel>
        </section>
      </PressPage>
    );
  }

  const pageTitle = variant === 'b' ? '文献整编台' : variant === 'c' ? 'OCR 校对控制台' : '书稿制作工作台';
  const pageDescription =
    variant === 'b'
      ? '把扫描稿整理成适合编校与归档的文献电子版。'
      : variant === 'c'
        ? '上传 PDF 后直接进入识别、问题定位、块级修订和导出。'
        : '上传扫描版 PDF，等待 MinerU 识别完成，然后进入元数据确认与逐页校对。';

  return (
    <PressPage title={pageTitle} description={pageDescription} home compact>
      {typeof window !== 'undefined' && window.jojoDesktop ? null : (
        <section className="variant-switcher" aria-label="界面版本切换">
          <div className="variant-switcher__intro">
            <strong>多版对比</strong>
            <span>选一个方向后，整条流程都会跟着切换。</span>
          </div>
          <div className="variant-switcher__options">
            {variants.map((item) => (
              <button
                key={item.id}
                className={`variant-chip ${item.id === variant ? 'variant-chip--active' : ''}`}
                type="button"
                aria-label={`${item.shortLabel}，${item.title}`}
                onClick={() => setVariant(item.id)}
              >
                <strong>{item.shortLabel}</strong>
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className={`page-layout page-layout--home page-layout--home-${variant}`}>
        <PressPanel
          title={variant === 'b' ? '新建整编任务' : variant === 'c' ? '新建 OCR 任务' : '新建任务'}
          className="panel--primary-action"
          as="section"
        >
          <p>
            {variant === 'b'
              ? '上传扫描稿后先完成识别，再核定题名、作者与封面，随后进入逐页校订。'
              : variant === 'c'
                ? '上传 PDF 后直接创建识别任务，并进入问题与 bbox 校对流程。'
                : '上传 PDF 后创建任务，并进入 MinerU 识别等待页。'}
          </p>
          <div className="upload-dropzone">
            <p>{variant === 'b' ? '把旧刊、讲稿或资料汇编拖进来，先建档，再校订。' : '拖拽 PDF 到这里，或直接从本地选择。'}</p>
            <PressActionLink to={pressPath('/projects/mock-1/recognition')}>选择 PDF 文件</PressActionLink>
          </div>

          <div className="mini-flow">
            <div><strong>1.</strong><span>上传 PDF</span></div>
            <div><strong>2.</strong><span>MinerU 识别</span></div>
            <div><strong>3.</strong><span>确认书籍信息</span></div>
            <div><strong>4.</strong><span>逐页校对与导出</span></div>
          </div>
        </PressPanel>

        <PressPanel title={variant === 'b' ? '待整编卷宗' : '最近任务'} meta={`${mockTasks.length} 个项目`} className="panel--project-list" as="section">
          <div className="task-list task-list--scrollable">
            {mockTasks.map((task) => <ProjectCard key={task.id} task={task} />)}
          </div>
        </PressPanel>
      </section>
    </PressPage>
  );
}
