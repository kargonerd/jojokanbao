// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineApplication } from './application';

const roots: string[] = [];

async function createApplication() {
  const root = await mkdtemp(path.join(tmpdir(), 'press-application-'));
  roots.push(root);
  return {
    root,
    application: new EngineApplication({
      projectsRoot: path.join(root, 'projects'),
      exportRoot: path.join(root, 'exports'),
    }),
  };
}

async function createProject(application: EngineApplication, name = '测试书') {
  return application.invoke('projects:create', { name }) as Promise<{
    project_id: string;
    name: string;
    current_stage: string;
  }>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('EngineApplication', () => {
  it('creates, lists, and loads projects without an HTTP server', async () => {
    const { application } = await createApplication();
    const created = await createProject(application);
    expect(created).toMatchObject({ name: '测试书', current_stage: 'recognition' });
    await expect(application.invoke('projects:list')).resolves.toContainEqual(
      expect.objectContaining({ id: created.project_id, title: '测试书' }),
    );
    await expect(application.invoke('projects:get', { projectId: created.project_id }))
      .resolves.toMatchObject({ currentStage: 'Recognition' });
  });

  it('validates metadata and advances the project stage', async () => {
    const { application } = await createApplication();
    const created = await createProject(application);
    await expect(application.invoke('projects:metadata:save', {
      projectId: created.project_id,
      title: '修订标题',
      subtitle: null,
      authors: ['编校组'],
      language: 'chinese_cht',
      coverAssetId: 'cover-1',
    })).resolves.toMatchObject({
      title: '修订标题',
      currentStage: 'Proofreading workspace',
    });
    await expect(application.invoke('projects:metadata:save', {
      projectId: created.project_id,
      title: '错误数据',
      authors: [123],
      language: 'chinese_cht',
    })).rejects.toMatchObject({ status: 422 });
  });

  it('imports a selected PDF into the project-owned directory', async () => {
    const { application, root } = await createApplication();
    const created = await createProject(application);
    const source = path.join(root, 'source.pdf');
    await writeFile(source, '%PDF-1.7');
    const imported = await application.invoke('projects:source:import', {
      projectId: created.project_id,
      sourcePath: source,
    }) as { pdf_path: string };
    expect(imported.pdf_path).toMatch(/^file:/);
    await expect(application.sourcePdfPath(created.project_id))
      .resolves.toMatch(/input[\\/]source\.pdf$/);
  });

  it('does not queue recognition when MinerU is not configured', async () => {
    const { application } = await createApplication();
    const created = await createProject(application);
    await expect(application.invoke('recognition:start', {
      projectId: created.project_id,
      pdfPath: 'C:/book.pdf',
    })).rejects.toMatchObject({ status: 503 });
    await expect(application.invoke('recognition:status', {
      projectId: created.project_id,
    })).resolves.toBeNull();
  });

  it('returns a pending proofreading workspace for unfinished recognition', async () => {
    const { application } = await createApplication();
    const created = await createProject(application);
    await application.projects.writeRecognition(created.project_id, {
      project_id: created.project_id,
      status: 'processing',
    });
    await expect(application.invoke('proofread:workspace', {
      projectId: created.project_id,
    })).resolves.toMatchObject({
      status: 'recognition_pending',
      block: null,
      preview: { documentUrl: `jojo-pdf://project/${created.project_id}` },
    });
  });

  it('cleans OCR noise and saves proofreading changes', async () => {
    const { application } = await createApplication();
    const created = await createProject(application);
    const project = await application.projects.load(created.project_id);
    project.blocks = [
      { id: 'page', type: 'page_number', text: '1', sourcePage: 1 },
      { id: 'heading', type: 'heading', text: '普通标题', sourcePage: 1 },
    ];
    await application.projects.save(project);
    const workspace = await application.invoke('proofread:workspace', {
      projectId: created.project_id,
    }) as { block: { id: string }; issues: Array<{ blockId: string }> };
    expect(workspace.block.id).toBe('heading');
    expect(workspace.issues).toContainEqual(expect.objectContaining({ blockId: 'heading' }));
    await application.invoke('proofread:block:save', {
      projectId: created.project_id,
      blockId: 'heading',
      text: '第一章',
    });
    expect((await application.projects.load(created.project_id)).blocks[1].text).toBe('第一章');
  });

  it('creates a chapter-aware EPUB through the command boundary', async () => {
    const { application } = await createApplication();
    const created = await createProject(application, 'EPUB 测试');
    const project = await application.projects.load(created.project_id);
    project.blocks = [
      { id: 'h1', type: 'heading', text: '第一章', sourcePage: 1 },
      { id: 'p1', type: 'paragraph', text: '正文', sourcePage: 1 },
    ];
    await application.projects.save(project);
    const result = await application.invoke('export:run', {
      projectId: created.project_id,
      optionId: 'epub',
    }) as { path: string };
    const archive = new AdmZip(await readFile(result.path));
    expect(archive.getEntry('OEBPS/chapters/chapter-001.xhtml')).not.toBeNull();
  });
});
