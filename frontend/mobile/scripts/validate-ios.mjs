import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const baseConfig = require(resolve(projectRoot, "app.json")).expo;
const configure = require(resolve(projectRoot, "app.config.js"));
const eas = require(resolve(projectRoot, "eas.json"));
const packageJson = require(resolve(projectRoot, "package.json"));

process.env.APP_VARIANT = "standard";
process.env.EXPO_PUBLIC_APP_VARIANT = "standard";
const config = configure({ config: baseConfig });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasPngChunk(bytes, expectedType) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    assert(offset + length + 12 <= bytes.length, "The iOS icon is a malformed PNG");
    if (type === expectedType) return true;
    offset += length + 12;
    if (type === "IEND") break;
  }
  return false;
}

assert(
  packageJson.version === config.version || packageJson.version.startsWith(`${config.version}-`),
  "The package version must match the App Store marketing version",
);
assert(/^\d+(?:\.\d+){0,2}$/u.test(config.version), "The App Store marketing version must be numeric");
assert(config.ios?.bundleIdentifier === "com.luoxixi.jojokanbao", "Unexpected iOS bundle identifier");
assert(config.jsEngine === undefined || config.jsEngine === "hermes", "The iOS release must not override Hermes");
assert(config.ios?.config?.usesNonExemptEncryption === false, "iOS encryption compliance must be declared");
assert(eas.cli?.appVersionSource === "remote", "Production build numbers must be managed remotely");
assert(eas.build?.production?.distribution === "store", "The production profile must create an App Store build");
assert(eas.build?.production?.autoIncrement === true, "Production build numbers must auto-increment");
assert(eas.build?.["ios-simulator"]?.ios?.simulator === true, "The iOS simulator profile is missing");

const iconPath = resolve(projectRoot, config.ios?.icon ?? "");
const icon = readFileSync(iconPath);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert(icon.subarray(0, 8).equals(pngSignature), "The iOS icon must be a PNG");
assert(icon.toString("ascii", 12, 16) === "IHDR", "The iOS icon has no PNG header");
assert(icon.readUInt32BE(16) === 1024 && icon.readUInt32BE(20) === 1024, "The iOS icon must be 1024x1024");
assert(icon[24] === 8 && icon[25] === 2, "The iOS icon must be an opaque 8-bit RGB PNG");
assert(!hasPngChunk(icon, "tRNS"), "The iOS icon must not contain transparency");

console.log("iOS release configuration is valid");
