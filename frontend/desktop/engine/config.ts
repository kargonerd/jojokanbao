import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type EngineConfig = {
  projectsRoot: string;
  exportRoot: string;
  mineruApiBase?: string;
  mineruApiToken?: string;
};

export function loadEngineConfig(): EngineConfig {
  const engineRoot = path.dirname(fileURLToPath(import.meta.url));
  return {
    projectsRoot: path.resolve(
      process.env.JOJO_PRESS_PROJECTS_ROOT ?? path.join(engineRoot, '.runtime', 'projects'),
    ),
    exportRoot: path.resolve(
      process.env.JOJO_PRESS_EXPORT_ROOT ?? path.join(engineRoot, '.runtime', 'exports'),
    ),
    mineruApiBase: 'https://mineru.net/api/v4',
  };
}
