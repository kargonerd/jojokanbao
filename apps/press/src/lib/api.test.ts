import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildApiUrl,
  createProject,
  fetchEngineHealth,
  fetchProjectList,
  fetchProjectMetadataConfirmation,
  fetchProjectOverview,
  runExportOption,
  saveProjectMetadataConfirmation,
  saveProofreadBlock,
  startRecognition,
  uploadProjectSourcePdf
} from './api';

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the local engine projects url', () => {
    expect(buildApiUrl('/projects')).toBe('http://127.0.0.1:8765/projects');
  });

  it('fetches engine health from the local engine over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchEngineHealth()).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/health', { method: 'GET' });
  });

  it('fetches the project list over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'project-demo',
          title: '革命造反年代',
          currentStage: 'Metadata confirmation'
        }
      ]
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProjectList()).resolves.toEqual([
      {
        id: 'project-demo',
        title: '革命造反年代',
        currentStage: 'Metadata confirmation'
      }
    ]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects', { method: 'GET' });
  });

  it('fetches the requested project overview over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'project-ops-handbook',
        title: '工作手册',
        currentStage: 'Proofreading workspace'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProjectOverview('project-ops-handbook')).resolves.toEqual({
      id: 'project-ops-handbook',
      title: '工作手册',
      currentStage: 'Proofreading workspace'
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/project-ops-handbook', { method: 'GET' });
  });

  it('fetches the requested project metadata confirmation over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'project-ops-handbook',
        title: '工作手册',
        subtitle: '发布工作手册',
        authors: ['编校组'],
        language: 'chinese_cht',
        coverAssetId: 'cover-ops-handbook'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProjectMetadataConfirmation('project-ops-handbook')).resolves.toEqual({
      id: 'project-ops-handbook',
      title: '工作手册',
      subtitle: '发布工作手册',
      authors: ['编校组'],
      language: 'chinese_cht',
      coverAssetId: 'cover-ops-handbook'
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/project-ops-handbook/metadata', { method: 'GET' });
  });

  it('saves metadata confirmation over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'project-demo',
        title: '革命造反年代（修订版）',
        subtitle: '编校版',
        authors: ['编校组', '质检组'],
        language: 'chinese_cht',
        coverAssetId: 'cover-revised',
        currentStage: 'Proofreading workspace'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(
      saveProjectMetadataConfirmation('project-demo', {
        title: '革命造反年代（修订版）',
        subtitle: '编校版',
        authors: ['编校组', '质检组'],
        language: 'chinese_cht',
        coverAssetId: 'cover-revised'
      })
    ).resolves.toEqual({
      id: 'project-demo',
      title: '革命造反年代（修订版）',
      subtitle: '编校版',
      authors: ['编校组', '质检组'],
      language: 'chinese_cht',
      coverAssetId: 'cover-revised',
      currentStage: 'Proofreading workspace'
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/project-demo/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '革命造反年代（修订版）',
        subtitle: '编校版',
        authors: ['编校组', '质检组'],
        language: 'chinese_cht',
        coverAssetId: 'cover-revised'
      })
    });
  });

  it('saves proofread block text over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        item: {
          id: 'heading-1',
          type: 'heading',
          text: '第一章 开始',
          source_page: 3
        }
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(saveProofreadBlock('project-ops-handbook', 'heading-1', '第一章 开始')).resolves.toEqual({
      id: 'heading-1',
      type: 'heading',
      text: '第一章 开始',
      source_page: 3
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/proofread/project-ops-handbook/blocks/heading-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '第一章 开始' })
    });
  });

  it('runs the selected export option over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'C:/exports/project-ops-handbook/markdown/book.md'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(runExportOption('project-ops-handbook', 'markdown')).resolves.toEqual({
      path: 'C:/exports/project-ops-handbook/markdown/book.md'
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/export/project-ops-handbook/markdown', {
      method: 'POST'
    });
  });

  it('creates a new project over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project_id: 'new-project-id',
        name: '革命造反年代',
        current_stage: 'recognition'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject('革命造反年代')).resolves.toEqual({
      project_id: 'new-project-id',
      name: '革命造反年代',
      current_stage: 'recognition'
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '革命造反年代' })
    });
  });

  it('uploads a browser-selected pdf for a created project over HTTP', async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], '革命造反年代.pdf', {
      type: 'application/pdf'
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pdf_path: 'file:///C:/projects/new-project-id/input/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadProjectSourcePdf('new-project-id', file)).resolves.toEqual({
      pdf_path: 'file:///C:/projects/new-project-id/input/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/projects/new-project-id/source-pdf?filename=%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: file
      }
    );
  });

  it('starts recognition for a created project over HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project_id: 'new-project-id',
        status: 'queued',
        engine: 'pipeline',
        language: 'chinese_cht',
        is_ocr: true,
        pdf_path: 'file:///C:/books/demo.pdf'
      })
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(startRecognition('new-project-id', 'file:///C:/books/demo.pdf')).resolves.toEqual({
      project_id: 'new-project-id',
      status: 'queued',
      engine: 'pipeline',
      language: 'chinese_cht',
      is_ocr: true,
      pdf_path: 'file:///C:/books/demo.pdf'
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/tasks/new-project-id/recognition/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_path: 'file:///C:/books/demo.pdf' })
    });
  });
});
