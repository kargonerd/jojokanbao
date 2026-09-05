const SENTENCE_PATTERN = /[^。！？!?；;]+[。！？!?；;]?/gu;

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hardSplit(value: string, maximum: number): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maximum) {
    const window = remaining.slice(0, maximum + 1);
    const candidates = [...window.matchAll(/[，、：:,]\s*/gu)];
    const splitAt = candidates.at(-1)?.index;
    const length = splitAt !== undefined && splitAt >= Math.floor(maximum * 0.55)
      ? splitAt + 1
      : maximum;
    chunks.push(remaining.slice(0, length).trim());
    remaining = remaining.slice(length).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitSpeechText(value: string, maximum = 500): string[] {
  const text = normalizedText(value);
  if (!text) return [];
  const sentences = text.match(SENTENCE_PATTERN) ?? [text];
  const segments: string[] = [];
  let current = "";
  const flush = () => {
    if (current) segments.push(current);
    current = "";
  };
  for (const sentence of sentences) {
    const normalized = normalizedText(sentence);
    if (!normalized) continue;
    if (normalized.length > maximum) {
      flush();
      segments.push(...hardSplit(normalized, maximum));
      continue;
    }
    if (current && current.length + normalized.length > maximum) flush();
    current += normalized;
  }
  flush();
  return segments;
}

export const SPEECH_EXCLUDED_ELEMENTS = "script,style,figure,figcaption,sup,[data-role='note'],[data-role='annotation']";
export const SPEECH_BLOCK_ELEMENTS = "h1,h2,h3,h4,p,li,blockquote";

function htmlBlocks(value: string): string[] {
  const document = new DOMParser().parseFromString(value, "text/html");
  document.querySelectorAll(
    SPEECH_EXCLUDED_ELEMENTS,
  ).forEach((element) => element.remove());
  const selector = SPEECH_BLOCK_ELEMENTS;
  const blocks = Array.from(document.body.querySelectorAll<HTMLElement>(selector))
    .filter((element) => !element.querySelector(selector))
    .map((element) => normalizedText(element.textContent ?? ""))
    .filter(Boolean);
  return blocks.length ? blocks : [normalizedText(document.body.textContent ?? "")].filter(Boolean);
}

export function speechSegments(
  title: string,
  body: string,
  format: "html" | "text",
  maximum = 500,
  parseHtml: (value: string) => string[] = htmlBlocks,
): string[] {
  const blocks = format === "html"
    ? parseHtml(body)
    : body.split(/\n{2,}/u).map(normalizedText).filter(Boolean);
  const normalizedTitle = normalizedText(title);
  const bodyBlocks = blocks[0] === normalizedTitle ? blocks.slice(1) : blocks;
  return [...splitSpeechText(normalizedTitle, maximum), ...splitSpeechText(bodyBlocks.join(" "), maximum)].filter(Boolean);
}
