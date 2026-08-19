import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createProject,
  fetchProjectList,
  importProjectSourcePdf,
  resolvePdfSelection,
  startRecognition,
} from './api';

const invoke = vi.fn();
const selectPdf = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  selectPdf.mockReset();
  window.jojoDesktop = {
    appName: 'jojo-desktop',
    selectPdf,
    engine: { invoke },
  } as unknown as JojoDesktopBridge;
});

describe('desktop engine client', () => {
  it('uses only the Electron bridge for project operations', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: [] });
    await expect(fetchProjectList()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('projects:list', {});
  });

  it('maps project creation, source import, and recognition commands', async () => {
    invoke
      .mockResolvedValueOnce({ ok: true, value: { project_id: 'p1' } })
      .mockResolvedValueOnce({ ok: true, value: { pdf_path: 'file:///book.pdf' } })
      .mockResolvedValueOnce({ ok: true, value: { status: 'queued' } });

    await createProject('书稿');
    await importProjectSourcePdf('p1', 'C:\\book.pdf');
    await startRecognition('p1', 'file:///book.pdf');

    expect(invoke.mock.calls).toEqual([
      ['projects:create', { name: '书稿' }],
      ['projects:source:import', { projectId: 'p1', sourcePath: 'C:\\book.pdf' }],
      ['recognition:start', { projectId: 'p1', pdfPath: 'file:///book.pdf' }],
    ]);
  });

  it('uses the native PDF picker', async () => {
    selectPdf.mockResolvedValue('C:\\book.pdf');
    await expect(resolvePdfSelection()).resolves.toEqual({ kind: 'path', value: 'C:\\book.pdf' });
  });

  it('preserves structured engine errors', async () => {
    invoke.mockResolvedValue({ ok: false, error: { status: 503, message: 'not configured' } });
    await expect(fetchProjectList()).rejects.toEqual(new ApiError('not configured', 503));
  });

  it('fails explicitly outside Electron instead of falling back to HTTP', async () => {
    delete window.jojoDesktop;
    await expect(fetchProjectList()).rejects.toMatchObject({ status: 503 });
  });
});
