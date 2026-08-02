import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EngineConfig } from './config.js';
import { HttpError } from './errors.js';
import { EXPORT_OPTIONS, exportProject, isExportOption } from './export-service.js';
import { buildProofreadIssues, cleanBlocks, type JsonObject, type ProjectDocument } from './model.js';
import { MineruService } from './mineru-service.js';
import { ProjectRepository } from './project-repository.js';
import { allowOnly, optionalString, requiredString, stringArray } from './validation.js';

export type EngineCommand =
  | 'health'
  | 'projects:list'
  | 'projects:get'
  | 'projects:create'
  | 'projects:metadata:get'
  | 'projects:metadata:save'
  | 'projects:source:import'
  | 'recognition:start'
  | 'recognition:status'
  | 'proofread:workspace'
  | 'proofread:block:save'
  | 'quality:get'
  | 'export:options'
  | 'export:run';

const overview = (project: ProjectDocument) => ({
  id: project.id,
  title: project.title,
  currentStage: project.currentStage,
  createdAt: project.createdAt,
  path: project.sourcePdf ?? null,
  coverUrl: null,
});

const localPath = (value: string) =>
  value.startsWith('file:') ? fileURLToPath(value) : path.resolve(value);

export class EngineApplication {
  readonly projects: ProjectRepository;
  readonly mineru: MineruService;

  constructor(private readonly config: EngineConfig) {
    this.projects = new ProjectRepository(config.projectsRoot);
    this.mineru = new MineruService(config, this.projects);
  }

  configureMineru(token?: string) {
    this.config.mineruApiBase = 'https://mineru.net/api/v4';
    this.config.mineruApiToken = token?.trim() || undefined;
  }

  async invoke(command: EngineCommand, payload: JsonObject = {}) {
    switch (command) {
      case 'health':
        return { status: 'ok' };
      case 'projects:list':
        return (await this.projects.list()).map(overview);
      case 'projects:get':
        return overview(await this.projects.load(requiredString(payload, 'projectId')));
      case 'projects:create':
        return this.createProject(payload);
      case 'projects:metadata:get':
        return this.getMetadata(requiredString(payload, 'projectId'));
      case 'projects:metadata:save':
        return this.saveMetadata(payload);
      case 'projects:source:import':
        return this.importSource(payload);
      case 'recognition:start':
        return this.startRecognition(payload);
      case 'recognition:status':
        return this.projects.readRecognition(requiredString(payload, 'projectId'));
      case 'proofread:workspace':
        return this.getWorkspace(requiredString(payload, 'projectId'));
      case 'proofread:block:save':
        return this.saveBlock(payload);
      case 'quality:get':
        await this.projects.load(requiredString(payload, 'projectId'));
        return { status: 'passed', checks: [] };
      case 'export:options':
        await this.projects.load(requiredString(payload, 'projectId'));
        return { options: EXPORT_OPTIONS };
      case 'export:run':
        return this.runExport(payload);
    }
  }

  async sourcePdfPath(projectId: string) {
    const project = await this.projects.load(projectId);
    if (!project.sourcePdf) throw new HttpError(404, 'source pdf not found');
    return localPath(project.sourcePdf);
  }

  private async createProject(payload: JsonObject) {
    allowOnly(payload, ['name']);
    const name = requiredString(payload, 'name');
    const id = randomUUID().replace(/-/g, '');
    await this.projects.save({
      id,
      title: name,
      currentStage: 'Recognition',
      createdAt: new Date().toISOString(),
      metadata: { subtitle: null, authors: [], language: 'chinese_cht', coverAssetId: null },
      blocks: [],
    });
    await mkdir(path.join(this.projects.directory(id), 'input'), { recursive: true });
    return { project_id: id, name, current_stage: 'recognition' };
  }

  private async getMetadata(projectId: string) {
    const project = await this.projects.load(projectId);
    return { id: project.id, title: project.title, ...project.metadata };
  }

  private async saveMetadata(payload: JsonObject) {
    allowOnly(payload, [
      'projectId',
      'title',
      'subtitle',
      'authors',
      'language',
      'coverAssetId',
      'cover_asset_id',
    ]);
    const project = await this.projects.load(requiredString(payload, 'projectId'));
    project.title = requiredString(payload, 'title');
    project.metadata = {
      subtitle: optionalString(payload, 'subtitle'),
      authors: stringArray(payload, 'authors'),
      language: requiredString(payload, 'language'),
      coverAssetId: payload.coverAssetId !== undefined
        ? optionalString(payload, 'coverAssetId')
        : optionalString(payload, 'cover_asset_id'),
    };
    project.currentStage = 'Proofreading workspace';
    await this.projects.save(project);
    return { id: project.id, title: project.title, ...project.metadata, currentStage: project.currentStage };
  }

  private async importSource(payload: JsonObject) {
    allowOnly(payload, ['projectId', 'sourcePath']);
    const projectId = requiredString(payload, 'projectId');
    const sourcePath = localPath(requiredString(payload, 'sourcePath'));
    if (path.extname(sourcePath).toLowerCase() !== '.pdf') {
      throw new HttpError(422, 'source file must be a PDF');
    }
    const target = path.join(this.projects.directory(projectId), 'input', path.basename(sourcePath));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourcePath, target);
    const project = await this.projects.load(projectId);
    project.sourcePdf = pathToFileURL(target).href;
    await this.projects.save(project);
    return { pdf_path: project.sourcePdf };
  }

  private async startRecognition(payload: JsonObject) {
    allowOnly(payload, ['projectId', 'pdfPath']);
    if (!this.mineru.configured) throw new HttpError(503, 'mineru gateway is not configured');
    const projectId = requiredString(payload, 'projectId');
    const pdfPath = requiredString(payload, 'pdfPath');
    const project = await this.projects.load(projectId);
    project.sourcePdf ??= pathToFileURL(localPath(pdfPath)).href;
    await this.projects.save(project);
    const task = {
      project_id: projectId,
      status: 'queued',
      engine: 'pipeline',
      language: 'chinese_cht',
      is_ocr: true,
      pdf_path: pdfPath,
    };
    await this.projects.writeRecognition(projectId, task);
    void this.mineru.process(projectId, task);
    return task;
  }

  private async getWorkspace(projectId: string) {
    const project = await this.projects.load(projectId);
    const recognition = await this.projects.readRecognition(projectId);
    if (recognition && recognition.status !== 'completed') {
      return {
        status: 'recognition_pending',
        notice: 'MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。',
        issues: [],
        preview: { page: 1, documentUrl: `jojo-pdf://project/${projectId}` },
        block: null,
        toc: [],
      };
    }
    const blocks = cleanBlocks(project.blocks);
    const first = blocks[0] ?? null;
    const pages = [...new Set(blocks.map((block) => block.sourcePage))]
      .sort((a, b) => a - b)
      .map((pageNum) => ({
        pageNum,
        blocks: blocks.filter((block) => block.sourcePage === pageNum).map((block) => ({
          id: block.id,
          type: block.type,
          text: block.text,
          bbox: block.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
          level: block.level ?? 0,
        })),
      }));
    return {
      status: blocks.length ? 'ready' : 'recognition_pending',
      notice: blocks.length ? null : 'MinerU 识别还没完成，当前还没有可校对文字。',
      issues: buildProofreadIssues(blocks),
      preview: {
        page: first?.sourcePage ?? 1,
        documentUrl: `jojo-pdf://project/${projectId}`,
        pages,
        totalPages: pages.length,
      },
      block: first ? { id: first.id, text: first.text } : null,
      toc: blocks.filter((block) => block.type === 'heading')
        .map((block) => ({ id: block.id, label: block.text })),
    };
  }

  private async saveBlock(payload: JsonObject) {
    allowOnly(payload, ['projectId', 'blockId', 'text']);
    const project = await this.projects.load(requiredString(payload, 'projectId'));
    const block = project.blocks.find((item) => item.id === requiredString(payload, 'blockId'));
    if (!block) throw new HttpError(404, 'block not found');
    block.text = requiredString(payload, 'text');
    await this.projects.save(project);
    return { item: block };
  }

  private async runExport(payload: JsonObject) {
    allowOnly(payload, ['projectId', 'optionId']);
    const project = await this.projects.load(requiredString(payload, 'projectId'));
    const option = requiredString(payload, 'optionId');
    if (!isExportOption(option)) throw new HttpError(422, 'unsupported export option');
    return { path: await exportProject(project, option, this.config.exportRoot) };
  }
}
