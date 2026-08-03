import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  agentDeploymentPackage,
  copyAgentAssets,
} from "./prepare-agent-assets.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const webDist = path.join(repositoryRoot, "frontend", "web", "dist");
const apiRoot = path.join(repositoryRoot, "backend");
const functionSource = path.join(apiRoot, "src", "app");
const functionEntry = path.join(repositoryRoot, "infrastructure", "edgeone", "functions", "api");
const outputDirectory = path.join(repositoryRoot, ".edgeone", "web-deploy");

async function requireFile(filePath) {
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile()) {
    throw new Error(`Required deployment file is missing: ${path.relative(repositoryRoot, filePath)}`);
  }
}

function includeFunctionFile(source) {
  const relative = path.relative(functionSource, source);
  const segments = relative.split(path.sep);
  return !segments.some((segment) =>
    segment === "tests"
    || segment === "__pycache__"
    || segment === ".pytest_cache"
    || segment === ".venv"
    || segment === "requirements-dev.txt"
    || segment === "olds"
    || segment === "rag"
  );
}

await requireFile(path.join(webDist, "index.html"));
await requireFile(path.join(functionEntry, "index.py"));
await requireFile(path.join(apiRoot, "requirements.txt"));

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(webDist, outputDirectory, { recursive: true });
const functionsOutput = path.join(outputDirectory, "cloud-functions");
await mkdir(functionsOutput, { recursive: true });
await cp(functionEntry, path.join(functionsOutput, "api"), { recursive: true });
await cp(functionSource, path.join(functionsOutput, "app"), {
  recursive: true,
  filter: includeFunctionFile,
});
await cp(path.join(apiRoot, "requirements.txt"), path.join(functionsOutput, "requirements.txt"));
await copyAgentAssets({
  repositoryRoot,
  outputDirectory,
  entriesDirectory: path.join(
    repositoryRoot,
    "infrastructure",
    "edgeone",
    "agents",
    "domestic",
  ),
});

const edgeoneConfig = JSON.parse(
  await readFile(path.join(repositoryRoot, "infrastructure", "edgeone", "edgeone.json"), "utf8"),
);
delete edgeoneConfig.devCommand;
edgeoneConfig.agents.dir = "agents";

await writeFile(
  path.join(outputDirectory, "edgeone.json"),
  `${JSON.stringify(edgeoneConfig, null, 2)}\n`,
);
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify(agentDeploymentPackage("jojo-web-deploy"), null, 2)}\n`,
);

process.stdout.write(`${outputDirectory}\n`);
