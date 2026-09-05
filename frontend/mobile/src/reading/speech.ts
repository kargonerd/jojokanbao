import { createSpeechClient, speechSegments } from "@jojo/content";
import * as Crypto from "expo-crypto";
import { Parser } from "htmlparser2";
import { mobileSpeechAllowed } from "./featureFlag";

const apiBase = process.env.EXPO_PUBLIC_READER_API_BASE?.replace(/\/$/u, "") || "https://beta.jojokanbao.cn";
export const mobileSpeechClient = createSpeechClient({
  allowed: mobileSpeechAllowed,
  apiUrl: (path) => `${apiBase}${path}`,
  digest: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
});

/** DOM-free equivalent of the reader's leaf-block extraction, including entities. */
export function nativeSpeechHtmlBlocks(html: string): string[] {
  const blocks: string[] = [];
  const root = { text: "", excluded: false, block: false, childBlock: false };
  const stack = [root];
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const parser = new Parser({
    onopentag(name, attrs) {
      const parent = stack[stack.length - 1]!;
      const excluded = parent.excluded || /^(head|script|style|figure|figcaption|sup)$/u.test(name) || ["note", "annotation"].includes(attrs["data-role"] ?? "");
      stack.push({ text: "", excluded, block: /^(h[1-4]|p|li|blockquote)$/u.test(name), childBlock: false });
    },
    ontext(text) { const current = stack[stack.length - 1]!; if (!current.excluded) current.text += text; },
    onclosetag() {
      if (stack.length < 2) return;
      const current = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      if (current.excluded) return;
      if (current.block && !current.childBlock && normalize(current.text)) blocks.push(normalize(current.text));
      parent.text += current.text;
      parent.childBlock ||= current.block || current.childBlock;
    },
  }, { decodeEntities: true });
  parser.end(html);
  return blocks.length ? blocks : [normalize(root.text)].filter(Boolean);
}

export function mobileSpeechSegments(title: string, body: string, format: "html" | "text") {
  return speechSegments(title, body, format, 500, nativeSpeechHtmlBlocks);
}

export function speechTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
