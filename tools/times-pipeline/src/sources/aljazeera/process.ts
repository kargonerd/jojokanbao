import { load } from "cheerio";
import { semanticParagraphs, type BodyQuality } from "../../content/paragraphs.js";

const SEMANTIC_BLOCKS = "p, h2, h3, blockquote, li";

export function extractAlJazeeraBody(html: string, quality: BodyQuality): string | undefined {
  const document = load(html);
  const paragraphs: string[] = [];

  document(".wysiwyg").each((_, container) => {
    document(container).find(SEMANTIC_BLOCKS).each((__, element) => {
      // A list item can wrap paragraphs. Keep only the innermost semantic block
      // so the same publisher text is not emitted twice.
      if (document(element).find(SEMANTIC_BLOCKS).length === 0) {
        paragraphs.push(document(element).text());
      }
    });
  });

  return semanticParagraphs(paragraphs, quality);
}
