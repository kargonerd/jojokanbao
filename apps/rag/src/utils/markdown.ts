import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

marked.setOptions({
  highlight: (code: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
} as any);

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

export function formatChatMarkdown(text: string): string {
  let html = marked.parse(text) as string;
  html = html.replace(
    /【([a-zA-Z0-9-]+):L(\d+)-L(\d+)】/g,
    '<span class="inline-flex items-center px-1.5 py-0.5 align-middle font-sans text-[10px] font-bold border border-red text-red bg-paper-soft" data-document-id="$1" data-start-line="$2" data-end-line="$3">L$2–$3</span>',
  );
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-document-id", "data-start-line", "data-end-line"] });
}
