import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function includeSourceFile(source) {
  const segments = source.split(path.sep);
  return !segments.some((segment) =>
    segment === "node_modules"
    || segment === ".turbo"
    || segment === "tests"
    || segment === "auth.json"
    || segment === ".gitignore"
    || segment === "README.md"
    || segment === "tsconfig.json"
    || segment === "smoke.ts"
    || segment === "push-codex-auth.ts"
    || segment.endsWith(".tmp")
  );
}

async function copyPackage(source, target, transform) {
  await cp(source, target, { recursive: true, filter: includeSourceFile });
  const packagePath = path.join(target, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  await writeFile(
    packagePath,
    `${JSON.stringify(transform(manifest), null, 2)}\n`,
  );
}

export async function copyAgentAssets({
  repositoryRoot,
  outputDirectory,
  entriesDirectory,
}) {
  const entriesOutput = path.join(outputDirectory, "agents");
  await mkdir(entriesOutput, { recursive: true });
  await cp(entriesDirectory, entriesOutput, {
    recursive: true,
    filter: includeSourceFile,
  });

  const packagesOutput = path.join(outputDirectory, "agent");
  await mkdir(packagesOutput, { recursive: true });
  await copyPackage(
    path.join(repositoryRoot, "agent", "runtime"),
    path.join(packagesOutput, "runtime"),
    (manifest) => ({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: "module",
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports,
      engines: manifest.engines,
      dependencies: manifest.dependencies,
    }),
  );
  await copyPackage(
    path.join(repositoryRoot, "agent", "edgeone"),
    path.join(packagesOutput, "edgeone"),
    (manifest) => ({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: "module",
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports,
      engines: manifest.engines,
      dependencies: {
        ...manifest.dependencies,
        "@jojo/agent-runtime": "file:../runtime",
      },
    }),
  );
}

export function agentDeploymentPackage(name) {
  return {
    name,
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    engines: { node: ">=22.19.0" },
    dependencies: {
      "@jojo/agent-edgeone": "file:agent/edgeone",
    },
  };
}
