import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { escapeHtml, type ProjectBlock, type ProjectDocument } from './model.js';

export const EXPORT_OPTIONS = [
  { id: 'markdown', label: 'Export Markdown' },
  { id: 'html', label: 'Export HTML' },
  { id: 'epub', label: 'Export EPUB' },
  { id: 'jojo-rag', label: 'Export jojo-rag Package' },
] as const;

export type ExportOption = typeof EXPORT_OPTIONS[number]['id'];
type ExportChapter = { id: string; title: string; order: number; blocks: ProjectBlock[] };

export function isExportOption(value: string | undefined): value is ExportOption {
  return EXPORT_OPTIONS.some((option) => option.id === value);
}

const cleanText = (value: string) =>
  value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
const trailingNewline = (value: string) =>
  `${value.trimEnd().replace(/\n{3,}/g, '\n\n')}\n`;
const readable = (block: ProjectBlock) =>
  block.type !== 'page_number' && Boolean(cleanText(block.text));
const heading = (block: ProjectBlock) =>
  block.type === 'heading' ||
  (Number(block.level) > 0 && cleanText(block.text).length <= 90);

export function buildChapters(project: ProjectDocument): ExportChapter[] {
  const blocks = project.blocks.filter(readable);
  if (!blocks.length) {
    return [{ id: 'chapter-001', title: project.title, order: 1, blocks: [] }];
  }

  const chapters: ExportChapter[] = [];
  let current: ProjectBlock[] = [];
  let title: string | undefined;
  let pendingHeadings: ProjectBlock[] = [];

  const flush = () => {
    if (!current.length) return;
    chapters.push({
      id: `chapter-${String(chapters.length + 1).padStart(3, '0')}`,
      title: title ?? cleanText(current[0]?.text ?? project.title).slice(0, 80),
      order: chapters.length + 1,
      blocks: current,
    });
    current = [];
    title = undefined;
  };
  const flushHeadings = () => {
    if (!pendingHeadings.length) return;
    if (current.length) flush();
    const joined = pendingHeadings.map((block) => cleanText(block.text)).filter(Boolean)
      .slice(0, 3).join(' - ');
    title = joined.length > 96 ? `${joined.slice(0, 95).trimEnd()}…` : joined;
    current.push(...pendingHeadings);
    pendingHeadings = [];
  };

  for (const block of blocks) {
    if (heading(block)) pendingHeadings.push(block);
    else {
      flushHeadings();
      current.push(block);
    }
  }
  flushHeadings();
  flush();
  return chapters.length
    ? chapters
    : [{ id: 'chapter-001', title: project.title, order: 1, blocks }];
}

function markdownBlock(block: ProjectBlock, text: string) {
  if (block.type === 'heading') return [`### ${text}`, ''];
  if (block.type === 'footnote') return [`> ${text}`, ''];
  if (block.type === 'table') return ['```', text, '```', ''];
  return [text, ''];
}

function chapterMarkdown(chapter: ExportChapter) {
  const lines = [`# ${chapter.title}`, ''];
  for (const block of chapter.blocks) {
    const text = cleanText(block.text);
    if (text && text !== chapter.title) lines.push(...markdownBlock(block, text));
  }
  return trailingNewline(lines.join('\n'));
}

export function buildMarkdown(project: ProjectDocument) {
  const lines = [`# ${project.title}`, ''];
  for (const chapter of buildChapters(project)) {
    lines.push(`## ${chapter.title}`, '');
    for (const block of chapter.blocks) {
      const text = cleanText(block.text);
      if (text && text !== chapter.title) lines.push(...markdownBlock(block, text));
    }
    lines.push('');
  }
  return trailingNewline(lines.join('\n'));
}

function htmlBlock(block: ProjectBlock) {
  const text = escapeHtml(cleanText(block.text)).replace(/\n/g, '<br>');
  if (block.type === 'heading') return `  <h3>${text}</h3>`;
  if (block.type === 'footnote') return `  <blockquote>${text}</blockquote>`;
  if (block.type === 'table') return `  <pre>${text}</pre>`;
  return `  <p>${text}</p>`;
}

export function buildHtml(project: ProjectDocument) {
  const sections = buildChapters(project).map((chapter) => {
    const blocks = chapter.blocks
      .filter((block) => cleanText(block.text) && cleanText(block.text) !== chapter.title)
      .map(htmlBlock).join('\n');
    return `<section id="${chapter.id}">\n  <h2>${escapeHtml(chapter.title)}</h2>\n${blocks}\n</section>`;
  }).join('\n');
  return trailingNewline(`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(project.title)}</title>
  <style>body{max-width:780px;margin:0 auto;padding:48px 24px;font-family:"Noto Serif SC","Songti SC",serif;line-height:1.85;color:#202020}h1,h2,h3{color:#8b1a1a;line-height:1.35}section{margin-top:2.5rem}p{margin:0 0 1rem}blockquote{border-left:3px solid #8b1a1a;margin:1rem 0;padding-left:1rem;color:#555}pre{white-space:pre-wrap;background:#f7f4ef;padding:1rem}</style>
</head>
<body>
  <h1>${escapeHtml(project.title)}</h1>
${sections}
</body>
</html>`);
}

function addRagPackage(archive: AdmZip, project: ProjectDocument) {
  const chapters = buildChapters(project);
  archive.addFile('manifest.json', Buffer.from(JSON.stringify({
    schema_version: '1.0',
    title: project.title,
    description: project.metadata.subtitle ?? '',
    book: {
      id: project.id,
      title: project.title,
      authors: project.metadata.authors,
      language: project.metadata.language,
    },
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      path: `chapters/${chapter.id}.md`,
      summary: chapter.blocks.map((block) => cleanText(block.text))
        .find((text) => text && text !== chapter.title)?.slice(0, 120) ?? '',
    })),
    toc: chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      chapter_id: chapter.id,
      level: 1,
      order: chapter.order,
    })),
    assets: [],
    annotations: [],
    reader_config: { default_theme: 'paper', source: 'jojo-press' },
  }, null, 2)));
  chapters.forEach((chapter) => {
    archive.addFile(`chapters/${chapter.id}.md`, Buffer.from(chapterMarkdown(chapter)));
  });
}

function addEpub(archive: AdmZip, project: ProjectDocument) {
  const chapters = buildChapters(project);
  const mimetype = archive.addFile('mimetype', Buffer.from('application/epub+zip'));
  mimetype.header.method = 0;
  archive.addFile('META-INF/container.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
    + '</rootfiles></container>',
  ));
  const manifest = chapters.map((chapter) =>
    `<item id="${chapter.id}" href="chapters/${chapter.id}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join('');
  const spine = chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join('');
  archive.addFile('OEBPS/content.opf', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:identifier id="book-id">${escapeHtml(project.id)}</dc:identifier>`
    + `<dc:title>${escapeHtml(project.title)}</dc:title>`
    + `<dc:language>${escapeHtml(project.metadata.language)}</dc:language>`
    + '</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    + `<item id="styles" href="styles.css" media-type="text/css"/>${manifest}</manifest>`
    + `<spine>${spine}</spine></package>`,
  ));
  const navItems = chapters.map((chapter) =>
    `<li><a href="chapters/${chapter.id}.xhtml">${escapeHtml(chapter.title)}</a></li>`,
  ).join('');
  archive.addFile('OEBPS/nav.xhtml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    + `<head><title>${escapeHtml(project.title)}</title><link rel="stylesheet" href="styles.css"/></head>`
    + `<body><nav epub:type="toc"><ol>${navItems}</ol></nav></body></html>`,
  ));
  archive.addFile('OEBPS/styles.css', Buffer.from(
    'body{font-family:serif;line-height:1.8}h1,h2,h3{line-height:1.35}p{margin:0 0 1em}pre{white-space:pre-wrap}',
  ));
  chapters.forEach((chapter) => {
    const body = chapter.blocks
      .filter((block) => cleanText(block.text) && cleanText(block.text) !== chapter.title)
      .map(htmlBlock).join('\n');
    archive.addFile(`OEBPS/chapters/${chapter.id}.xhtml`, Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<html xmlns="http://www.w3.org/1999/xhtml">'
      + `<head><title>${escapeHtml(chapter.title)}</title><link rel="stylesheet" href="../styles.css"/></head>`
      + `<body><h1>${escapeHtml(chapter.title)}</h1>${body}</body></html>`,
    ));
  });
}

export async function exportProject(
  project: ProjectDocument,
  option: ExportOption,
  exportRoot: string,
) {
  const extension =
    option === 'html' ? 'html' : option === 'markdown' ? 'md' : option === 'epub' ? 'epub' : 'zip';
  const filename = option === 'jojo-rag' ? 'jojo-rag-import.zip' : `book.${extension}`;
  const output = path.join(exportRoot, project.id, option, filename);
  await mkdir(path.dirname(output), { recursive: true });

  if (option === 'markdown') await writeFile(output, buildMarkdown(project), 'utf8');
  else if (option === 'html') await writeFile(output, buildHtml(project), 'utf8');
  else {
    const archive = new AdmZip();
    if (option === 'jojo-rag') addRagPackage(archive, project);
    else addEpub(archive, project);
    archive.writeZip(output);
  }
  return output;
}
