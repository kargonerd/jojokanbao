import path from "node:path";
import * as cheerio from "cheerio";

const DOCUMENT_NAMESPACES = new Set([
  "urn:oasis:names:tc:opendocument:xmlns:container",
  "http://www.idpf.org/2007/opf",
  "http://www.daisy.org/z3986/2005/ncx/",
  "http://www.w3.org/1999/xhtml",
]);

/** XML prefixes are aliases; publishers need not use the default namespace. */
export function loadEpubXml(source: string): cheerio.CheerioAPI {
  const $ = cheerio.load(source, { xmlMode: true });
  $("*").each((_index, element) => {
    if (!("attribs" in element)) return;
    const current = $(element);
    const namespace = (prefix: string): string | undefined => {
      for (const ancestor of [element, ...current.parents().toArray()]) {
        const value = $(ancestor).attr(`xmlns:${prefix}`);
        if (value) return value;
      }
      return undefined;
    };
    const separator = element.name.indexOf(":");
    if (separator >= 0 && DOCUMENT_NAMESPACES.has(namespace(element.name.slice(0, separator)) ?? "")) {
      element.name = element.name.slice(separator + 1);
    }
    for (const [name, value] of Object.entries(element.attribs)) {
      const [prefix, localName] = name.split(":");
      if (localName === "type" && namespace(prefix!) === "http://www.idpf.org/2007/ops") {
        current.attr("epub:type", value);
      }
    }
  });
  return $;
}

export function isExternalEpubReference(reference: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference);
}

export function resolveEpubReference(baseFile: string, reference: string): { file: string; anchor?: string } {
  const value = reference.trim();
  if (isExternalEpubReference(value)) throw new Error(`EPUB 引用不是包内路径：${value}`);
  const hash = value.indexOf("#");
  const rawPath = (hash < 0 ? value : value.slice(0, hash)).split("?", 1)[0]!;
  const anchor = hash < 0 ? "" : decodeURIComponent(value.slice(hash + 1));
  const decoded = decodeURIComponent(rawPath);
  const file = decoded
    ? path.posix.normalize(decoded.startsWith("/") ? decoded.slice(1) : path.posix.join(path.posix.dirname(baseFile), decoded))
    : baseFile;
  if (file === ".." || file.startsWith("../") || file.includes("\\") || file.includes("\0")) {
    throw new Error(`EPUB 引用超出包目录：${reference}`);
  }
  return { file, ...(anchor ? { anchor } : {}) };
}
