import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ async: false, breaks: true, gfm: true });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

export function formatChatMarkdown(text: string): string {
  let html = renderMarkdown(text);
  // Replace [n] citation patterns with clickable badges
  html = html.replace(/\[(\d+)\]/g, '<a class="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold border border-red text-red hover:bg-red hover:text-cream transition-colors cursor-pointer" data-citation="$1">$1</a>');
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-citation"] });
}
