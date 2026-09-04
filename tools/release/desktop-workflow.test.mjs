import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/release-desktop.yml", import.meta.url), "utf8");

test("publishes the initial desktop release without signing credentials", () => {
  assert.doesNotMatch(workflow, /WINDOWS_CSC_LINK|MACOS_CSC_LINK|APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(workflow, /当前桌面安装包尚未进行 Windows\/macOS 代码签名/);
  assert.match(workflow, /--win nsis --x64/);
  assert.match(workflow, /--mac dmg zip --arm64/);
  assert.match(workflow, /--linux AppImage deb --x64/);
});
