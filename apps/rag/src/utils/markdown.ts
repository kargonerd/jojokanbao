import { marked } from "marked";
import hljs from "highlight.js";

marked.setOptions({
  highlight: (code: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
} as any);

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

export function formatChatMarkdown(text: string): string {
  let html = renderMarkdown(text);
  // Replace [n] citation patterns with clickable badges
  html = html.replace(/\[(\d+)\]/g, '<a class="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold border border-red text-red hover:bg-red hover:text-cream transition-colors cursor-pointer" data-citation="$1">$1</a>');
  return html;
}
