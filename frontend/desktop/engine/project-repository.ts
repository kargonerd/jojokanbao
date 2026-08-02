import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';
import type { JsonObject, ProjectDocument } from './model.js';

export class ProjectRepository {
  constructor(readonly root: string) {}

  directory(projectId: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(projectId)) {
      throw new HttpError(422, 'invalid project id');
    }
    return path.join(this.root, projectId);
  }

  async load(projectId: string): Promise<ProjectDocument> {
    try {
      return JSON.parse(
        await readFile(path.join(this.directory(projectId), 'project.json'), 'utf8'),
      ) as ProjectDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'project not found');
      }
      throw error;
    }
  }

  async save(project: ProjectDocument) {
    const directory = this.directory(project.id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'project.json'),
      `${JSON.stringify(project, null, 2)}\n`,
      'utf8',
    );
  }

  async list() {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const projects = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
          return await this.load(entry.name);
        } catch {
          return null;
        }
      }),
    );
    return projects.filter((project): project is ProjectDocument => project !== null);
  }

  async readRecognition(projectId: string): Promise<JsonObject | null> {
    try {
      return JSON.parse(
        await readFile(path.join(this.directory(projectId), 'recognition.json'), 'utf8'),
      ) as JsonObject;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        throw new HttpError(409, 'recognition task state is corrupted');
      }
      throw error;
    }
  }

  async writeRecognition(projectId: string, task: JsonObject) {
    const target = path.join(this.directory(projectId), 'recognition.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  }
}
