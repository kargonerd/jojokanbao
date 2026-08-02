import { useEffect, useState } from 'react';
import { Outlet, createBrowserRouter, createMemoryRouter, isRouteErrorResponse, useLoaderData, useNavigate, useParams, useRouteError } from 'react-router-dom';
import type { LoaderFunctionArgs } from 'react-router-dom';

import { AppBootShell } from './AppBootShell';
import {
  createProject,
  fetchEngineHealth,
  fetchExportOptions,
  fetchProjectList,
  fetchProjectMetadataConfirmation,
  fetchProjectOverview,
  fetchProofreadWorkspace,
  fetchQualityStatus,
  getRecognitionStatus,
  importProjectSourcePdf,
  resolvePdfSelection,
  runExportOption,
  saveProjectMetadataConfirmation,
  saveProofreadBlock,
  startRecognition,
  type ApiError,
  type Project,
  type RecognitionTask
} from './lib/api';
import { getEngineStatusLabel, getStageLabel } from './lib/operatorDisplay';
import { PressActionLink, PressPage, PressPanel } from './components/PressUi';
import { MockVariantProvider } from './mock/variant-context';
import {
  mockExportPlan,
  mockMetadataDraft,
  mockRecognitionState,
  mockStructuredOutput,
  mockProofreadWorkspace,
  mockTasks
} from './mock/workflow';
import ProjectOverviewPage from './pages/ProjectOverviewPage';
import ProjectListPage, { NewProjectPage } from './pages/ProjectListPage';
import { RecognitionWaitingPage } from './pages/RecognitionWaitingPage';
import { MetadataConfirmPage } from './pages/MetadataConfirmPage';
import { ProofreadIssuesPage } from './pages/ProofreadIssuesPage';
import { QualityCheckPage } from './pages/QualityCheckPage';
import { ExportPage } from './pages/ExportPage';
import type {
  ExportOption,
  ProjectMetadataConfirmation,
  ProjectMetadataConfirmationUpdate,
  QualityStatus
} from './types/project';
import type { ProofreadWorkspace } from './types/issues';
import { pressPath } from './paths';

export type CreateAppRouterOptions = {
  initialEntries?: string[];
};

type RootLoaderData = {
  engineStatus: string;
  projects: Project[];
};

const STALE_SEEDED_PROJECTS = new Map([
  ['project-demo', 'Book Production Workspace'],
  ['project-ops-handbook', 'Operations Handbook']
]);

function isStaleSeededProject(project: Project) {
  return STALE_SEEDED_PROJECTS.get(project.id) === project.title;
}

function getProjectIdParam({ params }: LoaderFunctionArgs) {
  return params.projectId ?? '';
}

function VariantLayout() {
  return (
    <MockVariantProvider>
      <Outlet />
    </MockVariantProvider>
  );
}

async function loadRootData(): Promise<RootLoaderData> {
  try {
    const [health, projects] = await Promise.all([fetchEngineHealth(), fetchProjectList()]);
    return {
      engineStatus: getEngineStatusLabel(health.status),
      projects: projects.filter((project) => !isStaleSeededProject(project))
    };
  } catch {
    return {
      engineStatus: getEngineStatusLabel('offline'),
      projects: []
    };
  }
}

function RootProjectListRoute() {
  const data = useLoaderData() as RootLoaderData;
  const navigate = useNavigate();

  return (
    <ProjectListPage
      engineStatus={data.engineStatus}
      projects={data.projects.map((project) => ({
        id: project.id,
        title: project.title,
        currentStage: getStageLabel(project.currentStage),
        nextHref:
          project.currentStage === 'Proofreading workspace'
            ? pressPath(`/projects/${project.id}/proofread`)
            : pressPath(`/projects/${project.id}/metadata`),
        createdAt: project.createdAt ?? null,
        pdfUrl: project.path ?? null,
        coverUrl: project.coverUrl ?? null
      }))}
      onCreateProject={async (onPhaseChange) => {
        onPhaseChange('selecting');
        const selection = await resolvePdfSelection();
        if (!selection.value) {
          return { status: 'cancelled' as const };
        }

        onPhaseChange('creating');
        const sourceName = decodeURIComponent(selection.value.split(/[\\/]/).pop() ?? selection.value);
        const projectName = sourceName.replace(/\.pdf$/i, '');

        try {
          const createdProject = await createProject(projectName);
          const importResult = await importProjectSourcePdf(createdProject.project_id, selection.value);
          const pdfPath = importResult.pdf_path;

          await startRecognition(createdProject.project_id, pdfPath);
          await navigate(`${pressPath(`/projects/${createdProject.project_id}/recognition`)}${window.location.search}`);
          return { status: 'created' as const };
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError?.status === 503) {
            return { status: 'mineru_not_configured' as const };
          }

          return { status: 'error' as const };
        }
      }}
      mockTasks={mockTasks}
    />
  );
}

function NewProjectRoute() {
  const navigate = useNavigate();

  return (
    <NewProjectPage
      onCreateProject={async (onPhaseChange) => {
        onPhaseChange('selecting');
        const selection = await resolvePdfSelection();
        if (!selection.value) {
          return { status: 'cancelled' as const };
        }

        onPhaseChange('creating');
        const sourceName = decodeURIComponent(selection.value.split(/[\\/]/).pop() ?? selection.value);
        const projectName = sourceName.replace(/\.pdf$/i, '');

        try {
          const createdProject = await createProject(projectName);
          const importResult = await importProjectSourcePdf(createdProject.project_id, selection.value);
          const pdfPath = importResult.pdf_path;

          await startRecognition(createdProject.project_id, pdfPath);
          await navigate(`${pressPath(`/projects/${createdProject.project_id}/recognition`)}${window.location.search}`);
          return { status: 'created' as const };
        } catch (error) {
          const apiError = error as ApiError;
          if (apiError?.status === 503) {
            return { status: 'mineru_not_configured' as const };
          }

          return { status: 'error' as const };
        }
      }}
    />
  );
}

function MetadataRoute() {
  const project = useLoaderData() as ProjectMetadataConfirmation;
  const navigate = useNavigate();
  const { projectId = '' } = useParams();

  return (
    <MetadataConfirmPage
      project={project}
      onConfirm={async (payload: ProjectMetadataConfirmationUpdate) => {
        await saveProjectMetadataConfirmation(projectId, payload);
        await navigate(`${pressPath(`/projects/${projectId}/proofread`)}${window.location.search}`);
      }}
    />
  );
}

function ProofreadRoute() {
  const workspace = useLoaderData() as ProofreadWorkspace;
  const { projectId = '' } = useParams();

  return (
    <ProofreadIssuesPage
      projectId={projectId}
      workspace={workspace}
      onSaveBlock={async ({ blockId, text }) => {
        await saveProofreadBlock(projectId, blockId, text);
      }}
    />
  );
}

function QualityRoute() {
  const quality = useLoaderData() as QualityStatus;
  const { projectId = '' } = useParams();
  return <QualityCheckPage projectId={projectId} quality={quality} />;
}

function ExportRoute() {
  const options = useLoaderData() as ExportOption[];
  const { projectId = '' } = useParams();

  return <ExportPage projectId={projectId} options={options} onExport={(optionId) => runExportOption(projectId, optionId)} />;
}

function MockStructuredRoute() {
  const { projectId = 'mock-1' } = useParams();
  return <QualityCheckPage projectId={projectId} quality={mockStructuredOutput} />;
}

function RecognitionRoute() {
  const initialRecognition = useLoaderData() as RecognitionTask | null;
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [recognition, setRecognition] = useState<RecognitionTask | null>(initialRecognition);

  useEffect(() => {
    setRecognition(initialRecognition);
  }, [initialRecognition]);

  useEffect(() => {
    if (!projectId || !recognition || recognition.status === 'completed' || recognition.status === 'failed') {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void getRecognitionStatus(projectId).then((nextRecognition) => {
        if (cancelled || !nextRecognition) {
          return;
        }
        setRecognition(nextRecognition);
      });
    }, 300);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [projectId, recognition]);

  useEffect(() => {
    if (recognition?.status === 'completed') {
      void navigate(`${pressPath(`/projects/${projectId}/metadata`)}${window.location.search}`, { replace: true });
    }
  }, [navigate, projectId, recognition]);

  if (!recognition) {
    return <RecognitionWaitingPage recognition={mockRecognitionState} />;
  }

  return (
    <RecognitionWaitingPage
      recognition={recognition}
      onContinue={async () => {
        if (recognition.status === 'completed') {
          await navigate(`${pressPath(`/projects/${projectId}/metadata`)}${window.location.search}`);
        }
      }}
    />
  );
}

function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? error.statusText || String(error.status)
    : error instanceof Error
      ? error.message
      : '页面加载时出现未知错误';

  return (
    <PressPage
      title="页面加载失败"
      description="请返回首页重试，或检查当前项目资源是否已经准备完成。"
      actions={<PressActionLink to={pressPath()} tone="secondary">返回项目列表</PressActionLink>}
    >
      <section className="page-layout page-layout--single">
        <PressPanel title="错误信息" meta="需要处理">
          <p>{message}</p>
        </PressPanel>
      </section>
    </PressPage>
  );
}

export function createPressRoute() {
  return {
      path: '/press',
      element: <VariantLayout />,
      errorElement: <RouteErrorPage />,
      hydrateFallbackElement: <AppBootShell />,
      children: [
        {
          index: true,
          loader: loadRootData,
          element: <RootProjectListRoute />
        },
        {
          path: 'projects',
          loader: loadRootData,
          element: <RootProjectListRoute />
        },
        {
          path: 'projects/new',
          element: <NewProjectRoute />
        },
        {
          path: 'projects/:projectId',
          loader: async (args: LoaderFunctionArgs) => fetchProjectOverview(getProjectIdParam(args)),
          element: <ProjectOverviewPage />
        },
        {
          path: 'projects/:projectId/recognition',
          loader: async (args: LoaderFunctionArgs) => getRecognitionStatus(getProjectIdParam(args)),
          element: <RecognitionRoute />
        },
        {
          path: 'projects/:projectId/metadata',
          loader: async (args: LoaderFunctionArgs) => fetchProjectMetadataConfirmation(getProjectIdParam(args)),
          element: <MetadataRoute />
        },
        {
          path: 'projects/:projectId/proofread',
          loader: async (args: LoaderFunctionArgs) => fetchProofreadWorkspace(getProjectIdParam(args)),
          element: <ProofreadRoute />
        },
        {
          path: 'projects/:projectId/quality',
          loader: async (args: LoaderFunctionArgs) => fetchQualityStatus(getProjectIdParam(args)),
          element: <QualityRoute />
        },
        {
          path: 'projects/:projectId/structured',
          element: <MockStructuredRoute />
        },
        {
          path: 'projects/:projectId/export',
          loader: async (args: LoaderFunctionArgs) => fetchExportOptions(getProjectIdParam(args)),
          element: <ExportRoute />
        },
        {
          path: 'projects/mock-1/recognition',
          element: <RecognitionWaitingPage recognition={mockRecognitionState} mode="mock" />
        },
        {
          path: 'projects/mock-1/metadata',
          element: <MetadataConfirmPage project={mockMetadataDraft} mode="mock" projectId="mock-1" />
        },
        {
          path: 'projects/mock-1/proofread',
          element: <ProofreadIssuesPage workspace={mockProofreadWorkspace} />
        },
        {
          path: 'projects/mock-1/structured',
          element: <MockStructuredRoute />
        },
        {
          path: 'projects/mock-1/export',
          element: <ExportPage projectId="mock-1" plan={mockExportPlan} />
        }
      ]
    };
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
  const routes = [createPressRoute()];

  if (options.initialEntries) {
    const entries = options.initialEntries.map((entry) => {
      const url = new URL(entry, 'http://desktop.local');
      return `${pressPath(url.pathname)}${url.search}${url.hash}`;
    });
    return createMemoryRouter(routes, { initialEntries: entries });
  }

  return createBrowserRouter(routes);
}
