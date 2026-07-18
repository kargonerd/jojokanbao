#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";

const indexUrl = new URL("../dist/index.html", import.meta.url);
const assetsDir = new URL("../dist/assets/", import.meta.url);
const layerBlockPattern = /@layer(?:\s+[-\w.]+)?\s*\{/g;

function findClosingBrace(css, openingBrace) {
  let depth = 1;
  let quote = null;
  let inComment = false;

  for (let index = openingBrace + 1; index < css.length; index += 1) {
    const character = css[index];
    const nextCharacter = css[index + 1];

    if (inComment) {
      if (character === "*" && nextCharacter === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error("Unclosed @layer block in generated Reader CSS");
}

export function flattenCssLayers(css) {
  let result = css;

  while (true) {
    layerBlockPattern.lastIndex = 0;
    const match = layerBlockPattern.exec(result);
    if (!match) return result;

    const openingBrace = result.indexOf("{", match.index);
    const closingBrace = findClosingBrace(result, openingBrace);
    result = result.slice(0, match.index) + result.slice(openingBrace + 1, closingBrace) + result.slice(closingBrace + 1);
  }
}

const cssFiles = (await readdir(assetsDir)).filter((name) => name.endsWith(".css"));
let indexHtml = await readFile(indexUrl, "utf8");
for (const cssFile of cssFiles) {
  const url = new URL(cssFile, assetsDir);
  const source = await readFile(url, "utf8");
  const flattened = flattenCssLayers(source);
  const contentHash = createHash("sha256").update(flattened).digest("base64url").slice(0, 8);
  const hashedName = cssFile.replace(/-[^-]+\.css$/, `-${contentHash}.css`);

  await writeFile(url, flattened);
  if (hashedName !== cssFile) {
    await rename(url, new URL(hashedName, assetsDir));
    indexHtml = indexHtml.replaceAll(`assets/${cssFile}`, `assets/${hashedName}`);
  }
}
await writeFile(indexUrl, indexHtml);

console.log(`Flattened cascade layers in ${cssFiles.length} Reader CSS asset(s)`);
