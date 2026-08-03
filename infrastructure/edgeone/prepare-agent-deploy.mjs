import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDeploymentPackage,
  copyAgentAssets,
} from "./prepare-agent-assets.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const outputDirectory = path.join(repositoryRoot, ".edgeone", "agent-deploy");
const edgeoneRoot = path.join(repositoryRoot, "infrastructure", "edgeone");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyAgentAssets({
  repositoryRoot,
  outputDirectory,
  entriesDirectory: path.join(edgeoneRoot, "agents", "international"),
});
const cloudFunctionsOutput = path.join(outputDirectory, "cloud-functions");
await mkdir(cloudFunctionsOutput, { recursive: true });
await cp(
  path.join(edgeoneRoot, "functions", "agent-proxy"),
  path.join(cloudFunctionsOutput, "agent"),
  { recursive: true },
);

const edgeoneConfig = JSON.parse(
  await readFile(
    path.join(edgeoneRoot, "edgeone.agent-international.json"),
    "utf8",
  ),
);
edgeoneConfig.agents.dir = "agents";
await writeFile(
  path.join(outputDirectory, "edgeone.json"),
  `${JSON.stringify(edgeoneConfig, null, 2)}\n`,
);
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify(agentDeploymentPackage("jojo-agent-international-deploy"), null, 2)}\n`,
);

process.stdout.write(`${outputDirectory}\n`);
