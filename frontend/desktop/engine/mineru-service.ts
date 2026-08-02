import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';
import type { EngineConfig } from './config.js';
import {
  deepValue,
  firstString,
  normalizeBbox,
  normalizePage,
  type JsonObject,
  type ProjectBlock,
} from './model.js';
import { ProjectRepository } from './project-repository.js';

const MAX_MINERU_PAGES = 600;
const SPLIT_CHUNK_PAGES = 300;

type PdfPart = {
  path: string;
  pageOffset: number;
};

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function splitPdfForMineru(
  pdfPath: string,
  outputRoot: string,
): Promise<PdfPart[]> {
  const source = await PDFDocument.load(await readFile(pdfPath));
  if (source.getPageCount() <= MAX_MINERU_PAGES) {
    return [{ path: pdfPath, pageOffset: 0 }];
  }

  await mkdir(outputRoot, { recursive: true });
  const parts: PdfPart[] = [];
  for (let start = 0; start < source.getPageCount(); start += SPLIT_CHUNK_PAGES) {
    const end = Math.min(start + SPLIT_CHUNK_PAGES, source.getPageCount());
    const part = await PDFDocument.create();
    const pages = await part.copyPages(
      source,
      Array.from({ length: end - start }, (_, index) => start + index),
    );
    pages.forEach((page) => part.addPage(page));
    const partPath = path.join(
      outputRoot,
      `${path.parse(pdfPath).name}.part-${String(parts.length + 1).padStart(2, '0')}.pdf`,
    );
    await writeFile(partPath, await part.save());
    parts.push({ path: partPath, pageOffset: start });
  }
  return parts;
}

function contentToBlocks(content: JsonObject[], pageOffset: number, blockOffset: number) {
  return content.map<ProjectBlock>((item, index) => ({
    id: typeof item.id === 'string'
      ? blockOffset === 0 ? item.id : `${item.id}-${blockOffset + index}`
      : `block-${blockOffset + index + 1}`,
    type: ['heading', 'paragraph', 'footnote', 'image', 'table', 'page_number', 'toc'].includes(
      String(item.type),
    )
      ? String(item.type)
      : 'paragraph',
    text: typeof item.text === 'string' ? item.text : '',
    sourcePage: normalizePage(item, pageOffset),
    bbox: normalizeBbox(item.bbox),
    level: Number(item.level ?? item.text_level ?? 0),
  }));
}

export class MineruService {
  constructor(
    private readonly config: EngineConfig,
    private readonly projects: ProjectRepository,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pause: (milliseconds: number) => Promise<unknown> = delay,
  ) {}

  get configured() {
    return Boolean(this.config.mineruApiBase && this.config.mineruApiToken);
  }

  async process(projectId: string, task: JsonObject) {
    try {
      await this.projects.writeRecognition(projectId, { ...task, status: 'processing' });
      const source = String(task.pdf_path);
      const pdfPath = source.startsWith('file:') ? fileURLToPath(source) : path.resolve(source);
      const temporaryRoot = path.join(this.projects.directory(projectId), '.mineru-parts');
      const parts = await splitPdfForMineru(pdfPath, temporaryRoot).catch(() => [
        { path: pdfPath, pageOffset: 0 },
      ]);
      const blocks: ProjectBlock[] = [];
      const mergedContent: JsonObject[] = [];
      const artifactsRoot = path.join(this.projects.directory(projectId), 'artifacts');
      await mkdir(artifactsRoot, { recursive: true });
      try {
        for (const [index, part] of parts.entries()) {
          const { content, archive } = await this.processPart(part.path, task);
          const archiveName = parts.length === 1
            ? 'mineru-result.zip'
            : `mineru-result.part-${String(index + 1).padStart(2, '0')}.zip`;
          await writeFile(path.join(artifactsRoot, archiveName), archive);
          mergedContent.push(...content.map((item) => ({
            ...item,
            page_idx: normalizePage(item, part.pageOffset) - 1,
          })));
          blocks.push(...contentToBlocks(content, part.pageOffset, blocks.length));
        }
        await writeFile(
          path.join(artifactsRoot, 'content_list.json'),
          `${JSON.stringify(mergedContent, null, 2)}\n`,
          'utf8',
        );
      } finally {
        if (parts.length > 1) {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }

      const project = await this.projects.load(projectId);
      project.blocks = blocks;
      const title = blocks.find(
        (block) => ['heading', 'title'].includes(block.type) && block.text.trim(),
      );
      if (title) project.title = title.text.trim();
      project.currentStage = 'Metadata confirmation';
      await this.projects.save(project);
      await this.projects.writeRecognition(projectId, { ...task, status: 'completed' });
    } catch (error) {
      await this.projects.writeRecognition(projectId, {
        ...task,
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'recognition failed',
      }).catch(() => undefined);
    }
  }

  private async processPart(pdfPath: string, task: JsonObject) {
    const apiBase = this.config.mineruApiBase;
    const token = this.config.mineruApiToken;
    if (!apiBase || !token) throw new Error('mineru gateway is not configured');

    const fileName = path.basename(pdfPath);
    const submittedResponse = await this.fetchImpl(`${apiBase}/file-urls/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: task.language,
        is_ocr: task.is_ocr,
        engine: task.engine,
        files: [{ name: fileName, data_id: fileName }],
      }),
    });
    if (!submittedResponse.ok) {
      throw new Error(`MinerU submit failed: ${submittedResponse.status}`);
    }
    const submitted = await submittedResponse.json() as JsonObject;
    const batchId = firstString(
      submitted.batch_id,
      deepValue(submitted, 'data', 'batch_id'),
      deepValue(submitted, 'result', 'batch_id'),
    );
    const fileUrls =
      deepValue(submitted, 'data', 'file_urls') ??
      deepValue(submitted, 'result', 'file_urls');
    const uploadUrl = Array.isArray(fileUrls) ? firstString(fileUrls[0]) : undefined;
    if (!batchId || !uploadUrl) {
      throw new Error('MinerU response is missing upload information');
    }

    const uploadResponse = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      body: await readFile(pdfPath),
    });
    if (!uploadResponse.ok) {
      throw new Error(`MinerU upload failed: ${uploadResponse.status}`);
    }

    const archiveUrl = await this.waitForResult(apiBase, token, batchId);
    const archiveResponse = await this.fetchImpl(archiveUrl);
    if (!archiveResponse.ok) {
      throw new Error(`MinerU result download failed: ${archiveResponse.status}`);
    }
    const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
    const archive = new AdmZip(archiveBuffer);
    const contentEntry = archive.getEntries().find(
      (entry) => entry.entryName.endsWith('content_list.json'),
    );
    if (!contentEntry) throw new Error('MinerU result has no content_list.json');
    return {
      archive: archiveBuffer,
      content: JSON.parse(contentEntry.getData().toString('utf8')) as JsonObject[],
    };
  }

  private async waitForResult(apiBase: string, token: string, batchId: string) {
    for (let attempt = 0; attempt < 720; attempt += 1) {
      await this.pause(2000);
      const response = await this.fetchImpl(`${apiBase}/extract-results/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`MinerU status failed: ${response.status}`);
      const result = await response.json() as JsonObject;
      const items =
        deepValue(result, 'data', 'extract_result') ??
        deepValue(result, 'result', 'extract_result');
      const first = Array.isArray(items) ? items[0] as JsonObject | undefined : undefined;
      const status = String(first?.state ?? result.status ?? result.state ?? '').toLowerCase();
      if (['failed', 'error', 'canceled', 'cancelled', 'timeout'].includes(status)) {
        throw new Error(`MinerU task failed: ${status}`);
      }
      const archiveUrl = firstString(
        first?.full_zip_url,
        first?.zip_url,
        first?.download_url,
        result.full_zip_url,
        result.zip_url,
      );
      if (archiveUrl) return archiveUrl;
    }
    throw new Error('MinerU task timed out');
  }
}
