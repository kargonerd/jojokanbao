import React, { type ReactNode } from 'react';
import { Button, PageFrame, PageHeader, Panel } from '@jojo/ui';
import { Link } from 'react-router-dom';

import { useMockVariant } from '../mock/variant-context';
import { pressPath } from '../paths';
import { VariantLink } from './VariantLink';

type PressStep = 'recognition' | 'metadata' | 'proofread' | 'export';
type ProjectWorkspaceStep = 'overview' | 'metadata' | 'proofread' | 'export';

const PRESS_STEPS: Array<{ id: PressStep; label: string }> = [
  { id: 'recognition', label: '识别' },
  { id: 'metadata', label: '添加书籍信息' },
  { id: 'proofread', label: '文字和格式校对' },
  { id: 'export', label: '导出' }
];

interface PressPageProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  compact?: boolean;
  full?: boolean;
  home?: boolean;
  split?: boolean;
  showBrand?: boolean;
  showProjectListAction?: boolean;
  projectId?: string;
  activeStep?: ProjectWorkspaceStep;
  projectMeta?: ReactNode;
}

export function PressPage({
  title,
  description,
  actions,
  children,
  compact = false,
  full = false,
  home = false,
  split = false,
  showBrand = false,
  showProjectListAction,
  projectId,
  activeStep,
  projectMeta
}: PressPageProps) {
  const { variantDefinition } = useMockVariant();
  const projectMode = Boolean(projectId);
  const shouldShowProjectListAction = showProjectListAction ?? (!home && !projectMode);
  const shellClassName = [
    'workspace-shell',
    projectMode ? 'workspace-shell--project' : '',
    full ? 'workspace-shell--full' : '',
    home ? 'workspace-shell--home' : '',
    variantDefinition.themeClassName
  ].filter(Boolean).join(' ');
  const headerClassName = [
    'workspace-header',
    compact ? 'workspace-header--compact' : '',
    split ? 'workspace-header--split' : ''
  ].filter(Boolean).join(' ');

  const pageHeader = (
    <PageHeader
      eyebrow={showBrand ? 'jojo-press' : undefined}
      eyebrowClassName="app-kicker"
      title={title}
      description={description}
      descriptionClassName="page-lead"
      titleClassName="press-page-title"
      actions={
        shouldShowProjectListAction || actions || projectMeta ? (
          <div className="header-actions">
            {shouldShowProjectListAction ? (
              <PressActionLink tone="secondary" to={pressPath()} className="header-home-link">
                项目列表
              </PressActionLink>
            ) : null}
            {projectMeta ? <div className="header-meta">{projectMeta}</div> : null}
            {actions}
          </div>
        ) : undefined
      }
      className={headerClassName}
    />
  );

  return (
    <PageFrame as="main" maxWidth={full ? 'full' : 'xl'} className={shellClassName}>
      {projectMode && projectId ? (
        <div className="project-workspace">
          <nav className="project-nav" aria-label="项目导航">
            <VariantLink className="project-nav__home" to={pressPath()}>
              项目列表
            </VariantLink>
            <VariantLink className={`project-nav__item ${activeStep === 'overview' ? 'project-nav__item--active' : ''}`} to={pressPath(`/projects/${projectId}`)}>
              项目概览
            </VariantLink>
            <VariantLink className={`project-nav__item ${activeStep === 'metadata' ? 'project-nav__item--active' : ''}`} to={pressPath(`/projects/${projectId}/metadata`)}>
              书籍信息
            </VariantLink>
            <VariantLink className={`project-nav__item ${activeStep === 'proofread' ? 'project-nav__item--active' : ''}`} to={pressPath(`/projects/${projectId}/proofread`)}>
              文字校对
            </VariantLink>
            <VariantLink className={`project-nav__item ${activeStep === 'export' ? 'project-nav__item--active' : ''}`} to={pressPath(`/projects/${projectId}/export`)}>
              导出
            </VariantLink>
          </nav>
          <div className="project-workspace__main">
            {pageHeader}
            {children}
          </div>
        </div>
      ) : (
        <>
          {pageHeader}
          {children}
        </>
      )}
    </PageFrame>
  );
}

interface PressPanelProps {
  children: ReactNode;
  title?: ReactNode;
  meta?: ReactNode;
  className?: string;
  spacious?: boolean;
  as?: 'section' | 'article' | 'aside';
  labelledBy?: string;
}

export function PressPanel({ children, title, meta, className = '', spacious = false, as = 'article', labelledBy }: PressPanelProps) {
  const panelClassName = ['panel', spacious ? 'panel--spacious' : '', className].filter(Boolean).join(' ');

  return (
    <Panel as={as} className={panelClassName} aria-labelledby={labelledBy}>
      {title || meta ? (
        <div className="panel__header">
          {title ? <h2 id={labelledBy}>{title}</h2> : <span />}
          {meta ? <span>{meta}</span> : null}
        </div>
      ) : null}
      {children}
    </Panel>
  );
}

interface PressWorkbenchPanelProps extends Omit<PressPanelProps, 'className'> {
  className?: string;
}

export function PressWorkbenchPanel({ className = '', ...props }: PressWorkbenchPanelProps) {
  return <PressPanel className={`workbench-panel ${className}`} {...props} />;
}

export function PressStageStrip({ active }: { active: PressStep }) {
  return (
    <section className="stage-strip" aria-label="处理阶段">
      {PRESS_STEPS.map((step) => (
        <span key={step.id} className={step.id === active ? 'stage-strip__active' : undefined}>
          {step.label}
        </span>
      ))}
    </section>
  );
}

interface PressButtonProps extends React.ComponentProps<typeof Button> {
  tone?: 'primary' | 'secondary';
}

export function PressButton({ tone = 'primary', className = '', ...props }: PressButtonProps) {
  return (
    <Button
      variant={tone === 'primary' ? 'primary' : 'outline'}
      className={`${tone === 'primary' ? 'primary-button' : 'secondary-button'} ${className}`}
      {...props}
    />
  );
}

interface PressActionLinkProps {
  to: string;
  children: ReactNode;
  tone?: 'primary' | 'secondary';
  className?: string;
  preserveVariant?: boolean;
  'aria-label'?: string;
}

export function PressActionLink({ to, children, tone = 'primary', className = '', preserveVariant = true, ...props }: PressActionLinkProps) {
  const resolvedClassName = `${tone === 'primary' ? 'primary-button' : 'secondary-button'} ${className}`;

  if (!preserveVariant) {
    return (
      <Link className={resolvedClassName} to={to} {...props}>
        {children}
      </Link>
    );
  }

  return (
    <VariantLink className={resolvedClassName} to={to} {...props}>
      {children}
    </VariantLink>
  );
}
