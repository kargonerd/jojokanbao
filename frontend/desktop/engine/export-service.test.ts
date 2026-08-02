// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChapters,
  buildHtml,
  buildMarkdown,
  exportProject,
} from './export-service';
import type { ProjectDocument } from './model';

const temporaryRoots: string[] = [];
const project: ProjectDocument = {
  id: 'export-test',
  title: '测试书',
  currentStage: 'Export',
  createdAt: '2026-08-02T00:00:00.000Z',
  metadata: {
    subtitle: '副标题',
    authors: ['作者'],
    language: 'zh-Hant',
    coverAssetId: null,
  },
  blocks: [
    { id: 'h1', type: 'heading', text: '第一章', sourcePage: 1 },
    { id: 'p1', type: 'paragraph', text: '第一章正文', sourcePage: 1 },
    { id: 'note', type: 'footnote', text: '脚注', sourcePage: 2 },
    { id: 'h2', type: 'heading', text: '第二章', sourcePage: 3 },
    { id: 'table', type: 'table', text: '甲 | 乙', sourcePage: 3 },
  ],
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Press exports', () => {
  it('groups readable content by heading and preserves block semantics', () => {
    expect(buildChapters(project).map(({ title }) => title)).toEqual(['第一章', '第二章']);
    expect(buildMarkdown(project)).toContain('> 脚注');
    expect(buildMarkdown(project)).toContain('```\n甲 | 乙\n```');
    expect(buildHtml(project)).toContain('<blockquote>脚注</blockquote>');
    expect(buildHtml(project)).toContain('<pre>甲 | 乙</pre>');
  });

  it('writes every chapter to the RAG package and manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'press-export-'));
    temporaryRoots.push(root);
    const output = await exportProject(project, 'jojo-rag', root);
    expect(path.basename(output)).toBe('jojo-rag-import.zip');

    const archive = new AdmZip(await readFile(output));
    const manifest = JSON.parse(archive.readAsText('manifest.json'));
    expect(manifest.chapters).toHaveLength(2);
    expect(archive.getEntry('chapters/chapter-001.md')).not.toBeNull();
    expect(archive.getEntry('chapters/chapter-002.md')).not.toBeNull();
  });

  it('writes chapter navigation, styles, and spine entries to EPUB', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'press-export-'));
    temporaryRoots.push(root);
    const output = await exportProject(project, 'epub', root);
    const archive = new AdmZip(await readFile(output));

    expect(archive.readAsText('OEBPS/nav.xhtml')).toContain('chapter-002.xhtml');
    expect(archive.readAsText('OEBPS/content.opf')).toContain('<itemref idref="chapter-002"/>');
    expect(archive.getEntry('OEBPS/chapters/chapter-002.xhtml')).not.toBeNull();
  });
});
