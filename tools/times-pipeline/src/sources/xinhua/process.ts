import { load } from "cheerio";
import { plainText } from "../../text.js";

const imageCredit = /^(?:(?:文案|记者|海报制作|摄影|编辑|制作)\s*[:：]|新华社.*出品)/u;

function paragraph(value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<p>${escaped}</p>`;
}

export function extractXinhuaImageStoryBody(html: string): string | undefined {
  const document = load(html);
  const container = document("#detailContent").first();
  if (!container.length || !container.find(".image img, figure img").length) return undefined;
  const values = container.find("p").toArray()
    .map((element) => plainText(document(element).text()))
    .filter(Boolean);
  if (!values.length || values.some((value) => !imageCredit.test(value))) return undefined;
  return values.map(paragraph).join("");
}
