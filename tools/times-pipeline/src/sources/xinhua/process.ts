import type { Candidate } from "../../types.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function processXinhua(candidate: Candidate): Candidate {
  if (candidate.contentStatus === "full") return candidate;
  const message = candidate.title.match(/^新华社消息[丨|｜]\s*(.+)$/u)?.[1]?.trim();
  if (!message) return candidate;
  return {
    ...candidate,
    discoveryBody: `<p>${escapeHtml(message)}</p>`,
    contentStatus: "full",
  };
}
