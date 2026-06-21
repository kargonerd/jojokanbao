import { useEffect, useMemo, useState } from 'react';

import { PressActionLink, PressButton, PressPage, PressPanel } from '../components/PressUi';
import type { MockMetadataDraft, ProjectMetadataConfirmation, ProjectMetadataConfirmationUpdate } from '../types/project';

type MetadataPageMode = 'real' | 'mock';

type MetadataProject = ProjectMetadataConfirmation | MockMetadataDraft;

interface MetadataConfirmPageProps {
  project: MetadataProject;
  onConfirm?: (payload: ProjectMetadataConfirmationUpdate) => Promise<void> | void;
  mode?: MetadataPageMode;
  projectId?: string;
}

function isMockProject(project: MetadataProject): project is MockMetadataDraft {
  return 'coverCandidates' in project;
}

function getAuthorsText(project: MetadataProject) {
  return isMockProject(project) ? project.authorsText : (project.authors ?? []).join(', ');
}

export function MetadataConfirmPage({ project, onConfirm, mode = 'real', projectId }: MetadataConfirmPageProps) {
  const mockProject = isMockProject(project) ? project : null;
  const mockMode = mode === 'mock' || mockProject !== null;
  const [selectedPageNumber, setSelectedPageNumber] = useState(mockProject?.coverCandidates[0]?.pageNumber ?? 1);
  const [title, setTitle] = useState(project.title);
  const [subtitle, setSubtitle] = useState(project.subtitle ?? '');
  const [authors, setAuthors] = useState(getAuthorsText(project));
  const [language, setLanguage] = useState(project.language);
  const [coverAssetId, setCoverAssetId] = useState(project.coverAssetId ?? '');

  useEffect(() => {
    setTitle(project.title);
    setSubtitle(project.subtitle ?? '');
    setAuthors(getAuthorsText(project));
    setLanguage(project.language);
    setCoverAssetId(project.coverAssetId ?? '');
    if (mockProject) {
      setSelectedPageNumber(mockProject.coverCandidates[0]?.pageNumber ?? 1);
    }
  }, [project, mockProject]);

  const selectedCandidate = useMemo(
    () => mockProject?.coverCandidates.find((candidate) => candidate.pageNumber === selectedPageNumber) ?? mockProject?.coverCandidates[0],
    [mockProject, selectedPageNumber]
  );

  const handleConfirm = async () => {
    await onConfirm?.({
      title,
      subtitle: subtitle || null,
      authors: authors
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      language,
      coverAssetId: coverAssetId || null
    });
  };

  return (
      <PressPage
        title="确认书籍信息"
      projectId={projectId ?? (mockMode ? undefined : project.id)}
      activeStep="metadata"
      description={
        mockMode
          ? '默认使用第一页作为封面，也可以在候选页之间切换，然后确认自动预填的标题与作者。'
          : '请检查自动识别出的书名、作者、语言和封面信息。确认无误后继续。'
      }
    >
      <section className="page-layout page-layout--two-column">
        {mockProject ? (
          <PressPanel title="封面候选" meta={mockProject.sourceFileName}>
            <div className="cover-candidate-list">
              {mockProject.coverCandidates.map((candidate) => (
                <button
                  key={candidate.pageNumber}
                  className={`cover-candidate ${candidate.pageNumber === selectedPageNumber ? 'cover-candidate--selected' : ''}`}
                  type="button"
                  aria-label={`第 ${candidate.pageNumber} 页封面候选`}
                  onClick={() => setSelectedPageNumber(candidate.pageNumber)}
                >
                  <strong>{candidate.label}</strong>
                  <span>{candidate.excerpt}</span>
                </button>
              ))}
            </div>

            {selectedCandidate ? (
              <div className="cover-preview">
                <div className="cover-preview__page">第 {selectedCandidate.pageNumber} 页</div>
                <div className="cover-preview__mock">封面预览</div>
                <p>{selectedCandidate.excerpt}</p>
              </div>
            ) : null}
          </PressPanel>
        ) : (
          <PressPanel title="检查清单" meta="继续之前请核对">
            <ul className="summary-list">
              <li>检查书名是否正确</li>
              <li>补充或确认副标题</li>
              <li>确认作者信息</li>
              <li>确认语言</li>
              <li>确认封面资源编号</li>
            </ul>
          </PressPanel>
        )}

        <PressPanel title="元数据" meta={mockProject?.confidenceNote ?? '这些字段会进入后续校对与导出结果。'}>
          <form className="metadata-form" onSubmit={(event) => event.preventDefault()}>
            <label className="form-group">
              <span>书名</span>
              <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="form-group">
              <span>副标题</span>
              <input type="text" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} />
            </label>
            <label className="form-group">
              <span>作者</span>
              <input type="text" value={authors} onChange={(event) => setAuthors(event.target.value)} />
            </label>
            <label className="form-group">
              <span>语言</span>
              <input type="text" value={language} onChange={(event) => setLanguage(event.target.value)} />
            </label>
            <label className="form-group">
              <span>封面资源编号</span>
              <input type="text" value={coverAssetId} onChange={(event) => setCoverAssetId(event.target.value)} />
            </label>
          </form>

          <div className="inline-actions">
            {mockMode ? (
              <PressActionLink tone="secondary" to="/projects/mock-1/recognition">
                返回识别状态
              </PressActionLink>
            ) : null}
            <PressButton type="button" onClick={handleConfirm}>
              确认并进入文字和格式校对
            </PressButton>
          </div>
        </PressPanel>
      </section>
    </PressPage>
  );
}
