import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checkOnly = process.argv.includes("--check");
const targets = [
  {
    workspace: "@jojo/web",
    output: "frontend/web/src/legal/open-source-notices.generated.json",
  },
  {
    workspace: "@jojo/mobile",
    output: "frontend/mobile/src/legal/open-source-notices.generated.json",
  },
  {
    workspace: "@jojo/desktop",
    output: "frontend/desktop/src/legal/open-source-notices.generated.json",
    includeDevelopmentDependencies: true,
  },
];

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath;
  const result = pnpmCli
    ? spawnSync(process.execPath, [pnpmCli, ...args], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    : spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });

  if (result.status !== 0) {
    throw new Error(result.stderr || `pnpm ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function normalizedAuthor(author) {
  if (typeof author === "string") return author.trim();
  if (author && typeof author.name === "string") return author.name.trim();
  return "";
}

function normalizedRepository(packageJson) {
  const repository = typeof packageJson.repository === "string"
    ? packageJson.repository
    : packageJson.repository?.url;
  const url = packageJson.homepage || repository || "";
  return String(url)
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git(?:#.*)?$/, "");
}

function noticeFiles(packagePath) {
  return readdirSync(packagePath)
    .filter((name) => /^(licen[sc]e|notice|copying|copyright)(?:[._-].*)?$/i.test(name))
    .map((name) => ({ name, path: resolve(packagePath, name) }))
    .filter((file) => statSync(file.path).isFile())
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function createTargetData(workspace, includeDevelopmentDependencies = false) {
  const command = [
    "licenses",
    "list",
    "--json",
    "--filter",
    workspace,
  ];
  if (!includeDevelopmentDependencies) command.splice(2, 0, "--prod");
  const report = JSON.parse(runPnpm(command));
  const packages = new Map();
  const notices = new Map();

  for (const [reportedLicense, entries] of Object.entries(report)) {
    for (const entry of entries) {
      for (const packagePath of entry.paths || []) {
        const packageJsonPath = resolve(packagePath, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (!packageJson.name || !packageJson.version || packageJson.name.startsWith("@jojo/")) continue;

        const key = `${packageJson.name}@${packageJson.version}`;
        const existing = packages.get(key);
        const noticeIds = new Set(existing?.noticeIds || []);
        for (const file of noticeFiles(packagePath)) {
          const text = readFileSync(file.path, "utf8").replace(/\r\n/g, "\n").trim();
          if (!text) continue;
          const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
          noticeIds.add(id);
          if (!notices.has(id)) notices.set(id, { fileName: file.name, text });
        }

        packages.set(key, {
          id: key,
          name: packageJson.name,
          version: packageJson.version,
          license: typeof packageJson.license === "string" ? packageJson.license : reportedLicense,
          author: normalizedAuthor(packageJson.author || entry.author),
          homepage: normalizedRepository(packageJson) || entry.homepage || "",
          noticeIds: [...noticeIds].sort(),
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    lockfileSha256: createHash("sha256")
      .update(readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml")))
      .digest("hex"),
    projectLicense: readFileSync(resolve(repositoryRoot, "LICENSE"), "utf8")
      .replace(/\r\n/g, "\n")
      .trim(),
    packages: [...packages.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "en") || left.version.localeCompare(right.version, "en")),
    notices: Object.fromEntries([...notices.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))),
  };
}

let stale = false;
for (const target of targets) {
  const outputPath = resolve(repositoryRoot, target.output);
  const expected = `${JSON.stringify(createTargetData(
    target.workspace,
    target.includeDevelopmentDependencies,
  ), null, 2)}\n`;
  if (checkOnly) {
    if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== expected) {
      console.error(`${target.output} is stale; run pnpm notices:generate`);
      stale = true;
    }
    continue;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, expected);
  console.log(`Generated ${target.output}`);
}

if (stale) process.exitCode = 1;
