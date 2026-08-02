// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRepository } from './project-repository';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('ProjectRepository', () => {
  it('rejects identifiers that could escape the project root', () => {
    const repository = new ProjectRepository('C:/projects');
    expect(() => repository.directory('../outside')).toThrow('invalid project id');
  });

  it('distinguishes missing and corrupted recognition state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'press-repository-'));
    temporaryRoots.push(root);
    const repository = new ProjectRepository(root);

    await expect(repository.readRecognition('project-1')).resolves.toBeNull();
    await mkdir(repository.directory('project-1'), { recursive: true });
    await writeFile(
      path.join(repository.directory('project-1'), 'recognition.json'),
      '{not-json',
    );
    await expect(repository.readRecognition('project-1')).rejects.toMatchObject({ status: 409 });
  });
});
