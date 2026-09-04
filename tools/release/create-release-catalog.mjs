import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopFeeds = {
  "desktop-windows-x64": { feed: "win-x64", platform: "windows", arch: "x64" },
  "desktop-macos-arm64": { feed: "mac-arm64", platform: "macos", arch: "arm64" },
  "desktop-macos-x64": { feed: "mac-x64", platform: "macos", arch: "x64" },
  "desktop-linux-x64": { feed: "linux-x64", platform: "linux", arch: "x64" },
};

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${name ?? "end"}`);
    values[name.slice(2)] = value;
  }
  return values;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }));
  return nested.flat();
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function artifactLabel(platform, arch, extension) {
  if (platform === "windows") return `Windows 10/11（${arch}）`;
  if (platform === "macos") return arch === "arm64" ? "macOS（Apple 芯片）" : "macOS（Intel）";
  if (platform === "linux" && extension === "appimage") return `Linux AppImage（${arch}）`;
  if (platform === "linux") return `Linux DEB（${arch}）`;
  return "Android 安装包";
}

function urlFor(baseUrl, ...segments) {
  return `${baseUrl.replace(/\/+$/, "")}/${segments.map(encodeURIComponent).join("/")}`;
}

async function desktopArtifacts(input, baseUrl, channel) {
  const files = await listFiles(input);
  const artifacts = [];
  for (const file of files) {
    const relative = path.relative(input, file);
    const [artifactDirectory] = relative.split(path.sep);
    const feed = desktopFeeds[artifactDirectory];
    if (!feed) continue;
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!["exe", "dmg", "appimage", "deb"].includes(extension)) continue;
    const details = await stat(file);
    artifacts.push({
      id: `${feed.feed}-${extension}`,
      platform: feed.platform,
      arch: feed.arch,
      format: extension,
      label: artifactLabel(feed.platform, feed.arch, extension),
      url: urlFor(baseUrl, "releases", "desktop", channel, feed.feed, path.basename(file)),
      size: details.size,
      sha256: await sha256(file),
      ...(feed.platform === "windows" ? { minimumOs: "Windows 10" } : {}),
      ...(feed.platform === "macos" ? { minimumOs: "macOS 12" } : {}),
    });
  }
  return artifacts.sort((left, right) => left.id.localeCompare(right.id));
}

async function mobileArtifacts(input, baseUrl, channel, variant) {
  const files = await listFiles(input);
  const apk = files.find((file) => path.extname(file).toLowerCase() === ".apk");
  if (!apk) throw new Error(`No APK found under ${input}`);
  const details = await stat(apk);
  const productPath = variant === "eink" ? "android-eink" : "android";
  return [{
    id: variant === "eink" ? "android-eink" : "android-standard",
    platform: "android",
    arch: "universal",
    format: "apk",
    label: variant === "eink" ? "Android 墨水屏版" : "Android 标准版",
    url: urlFor(baseUrl, "releases", "mobile", productPath, channel, path.basename(apk)),
    size: details.size,
    sha256: await sha256(apk),
    minimumOs: "Android 7",
  }];
}

export async function createReleaseCatalog(options) {
  const {
    product,
    variant,
    channel,
    version,
    buildNumber,
    mandatory,
    minimumVersion,
    notes,
    publishedAt,
    baseUrl,
    repositoryUrl,
    tag,
    input,
  } = options;
  if (!['desktop', 'mobile'].includes(product)) throw new Error(`Unsupported product: ${product}`);
  if (channel !== "stable") throw new Error(`Unsupported channel: ${channel}`);
  if (!version || !baseUrl || !repositoryUrl || !tag || !input) throw new Error("Missing required release catalog option");
  if (product === "mobile" && !["standard", "eink"].includes(variant)) throw new Error(`Unsupported mobile variant: ${variant}`);
  const normalizedBuildNumber = Number(buildNumber);
  if (product === "mobile" && (!Number.isInteger(normalizedBuildNumber) || normalizedBuildNumber < 1)) {
    throw new Error("Mobile release catalogs require a positive integer build number");
  }
  const artifacts = product === "desktop"
    ? await desktopArtifacts(input, baseUrl, channel)
    : await mobileArtifacts(input, baseUrl, channel, variant);
  if (!artifacts.length) throw new Error(`No public release artifacts found under ${input}`);
  return {
    schemaVersion: 1,
    product,
    ...(product === "mobile" ? { variant } : {}),
    channel,
    version,
    ...(product === "mobile" ? { buildNumber: normalizedBuildNumber } : {}),
    publishedAt: publishedAt || new Date().toISOString(),
    ...(notes ? { notes } : {}),
    releaseNotesUrl: `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`,
    sourceUrl: `${repositoryUrl}/tree/${encodeURIComponent(tag)}`,
    mandatory: mandatory === true || mandatory === "true",
    minimumVersion: minimumVersion || null,
    artifacts,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const catalog = await createReleaseCatalog({
    product: args.product,
    variant: args.variant,
    channel: args.channel,
    version: args.version,
    buildNumber: args["build-number"],
    mandatory: args.mandatory,
    minimumVersion: args["minimum-version"],
    notes: args.notes,
    publishedAt: args["published-at"],
    baseUrl: args["base-url"],
    repositoryUrl: args["repository-url"],
    tag: args.tag,
    input: path.resolve(args.input),
  });
  const output = path.resolve(args.output);
  await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
