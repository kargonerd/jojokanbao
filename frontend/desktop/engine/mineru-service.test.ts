// @vitest-environment node

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MineruService, splitPdfForMineru } from './mineru-service';
import { ProjectRepository } from './project-repository';

const temporaryRoots: string[] = [];

async function createPdf(pageCount: number, target: string) {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) document.addPage();
  await writeFile(target, await document.save());
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('MinerU PDF preparation', () => {
  it('keeps PDFs within the MinerU limit as one file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'press-mineru-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source.pdf');
    await createPdf(600, source);

    await expect(splitPdfForMineru(source, path.join(root, 'parts'))).resolves.toEqual([
      { path: source, pageOffset: 0 },
    ]);
  });

  it('splits oversized PDFs into 300-page chunks with source-page offsets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'press-mineru-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source.pdf');
    await createPdf(601, source);

    const parts = await splitPdfForMineru(source, path.join(root, 'parts'));
    expect(parts.map(({ pageOffset }) => pageOffset)).toEqual([0, 300, 600]);

    const pageCounts = await Promise.all(
      parts.map(async (part) =>
        (await PDFDocument.load(await readFile(part.path))).getPageCount()),
    );
    expect(pageCounts).toEqual([300, 300, 1]);
  });

  it('persists the raw MinerU archive, normalized content, project, and task state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'press-mineru-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source.pdf');
    await createPdf(1, source);
    const projects = new ProjectRepository(path.join(root, 'projects'));
    await projects.save({
      id: 'project-1',
      title: '待识别',
      currentStage: 'Recognition',
      createdAt: '2026-08-02T00:00:00.000Z',
      metadata: { subtitle: null, authors: [], language: 'zh-Hant', coverAssetId: null },
      blocks: [],
    });
    const archive = new AdmZip();
    archive.addFile('result/content_list.json', Buffer.from(JSON.stringify([
      { id: 'heading', type: 'heading', text: '识别标题', page_idx: 0, bbox: [1, 2, 11, 22] },
    ])));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { batch_id: 'batch-1', file_urls: ['https://upload.test/file'] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { extract_result: [{ state: 'done', full_zip_url: 'https://download.test/file' }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(archive.toBuffer(), { status: 200 }));
    const service = new MineruService(
      {
        projectsRoot: projects.root,
        exportRoot: path.join(root, 'exports'),
        mineruApiBase: 'https://mineru.test',
        mineruApiToken: 'token',
      },
      projects,
      fetchMock,
      async () => undefined,
    );

    await service.process('project-1', {
      project_id: 'project-1',
      status: 'queued',
      pdf_path: source,
      language: 'chinese_cht',
      is_ocr: true,
      engine: 'pipeline',
    });

    expect(await projects.readRecognition('project-1')).toMatchObject({ status: 'completed' });
    expect(await projects.load('project-1')).toMatchObject({
      title: '识别标题',
      currentStage: 'Metadata confirmation',
      blocks: [{ id: 'heading', sourcePage: 1, bbox: { x: 1, y: 2, width: 10, height: 20 } }],
    });
    await expect(access(path.join(
      projects.directory('project-1'),
      'artifacts',
      'mineru-result.zip',
    ))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path.join(
      projects.directory('project-1'),
      'artifacts',
      'content_list.json',
    ), 'utf8'))).toHaveLength(1);
  });
});
