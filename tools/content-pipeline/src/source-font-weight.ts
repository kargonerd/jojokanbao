import type * as cheerio from "cheerio";
import postcss from "postcss";

interface WeightRule {
  value: string;
  rank: number[];
}

function later(left: number[], right: number[]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return true;
}

function fontWeight(value: string, inherited: number): number | undefined {
  const normalized = value.toLowerCase().trim();
  if (normalized === "bold") return 700;
  if (normalized === "normal" || normalized === "initial") return 400;
  if (normalized === "inherit" || normalized === "unset") return inherited;
  if (normalized === "bolder") return inherited < 350 ? 400 : inherited < 550 ? 700 : 900;
  if (normalized === "lighter") return inherited < 550 ? 100 : inherited < 750 ? 400 : 700;
  const number = Number(normalized);
  return number >= 1 && number <= 1000 ? number : undefined;
}

/** Read static book CSS, then keep its weight as semantic strong elements.
 * No source CSS, fonts, imports or URLs are executed by the Reader.
 * Supported selectors are tag/class/ID compounds, lists and combinators;
 * dynamic/pseudo selectors and conditional at-rules are deliberately ignored.
 */
export function preserveSourceFontWeight($: cheerio.CheerioAPI, stylesheets: string[] = []): void {
  type Element = ReturnType<cheerio.CheerioAPI>[number];
  const weights = new Map<Element, WeightRule>();
  let order = 0;
  const setWeight = (element: Element, value: string, rank: number[]) => {
    if (fontWeight(value, 400) === undefined) return;
    const previous = weights.get(element);
    if (!previous || later(rank, previous.rank)) weights.set(element, { value, rank });
  };

  for (const css of [...stylesheets, ...$("style").map((_index, element) => $(element).text()).get()]) {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      if (rule.parent?.type !== "root") return;
      for (const selector of rule.selectors) {
        // Restrict matching to static selectors whose specificity is unambiguous.
        if (!/^(?:[#.]?[\p{L}_-][\p{L}\p{N}_-]*|\*|[\s>+~])+$/u.test(selector)) continue;
        const tokens = selector.match(/[#.]?[\p{L}_-][\p{L}\p{N}_-]*/gu) ?? [];
        const specificity = [tokens.filter((token) => token.startsWith("#")).length,
          tokens.filter((token) => token.startsWith(".")).length,
          tokens.filter((token) => !/^[#.]/.test(token)).length];
        let matches: ReturnType<cheerio.CheerioAPI>;
        try { matches = $(selector); } catch { continue; }
        rule.each((declaration) => {
          if (declaration.type !== "decl" || declaration.prop.toLowerCase() !== "font-weight") return;
          order += 1;
          const rank = [Number(Boolean(declaration.important)), 0, ...specificity, order];
          matches.each((_index, element) => setWeight(element, declaration.value, rank));
        });
      }
    });
  }
  $("[style]").each((_index, element) => {
    const root = postcss.parse(`source{${$(element).attr("style")}}`);
    const rule = root.first;
    if (rule?.type !== "rule") return;
    rule.each((declaration) => {
      if (declaration.type === "decl" && declaration.prop.toLowerCase() === "font-weight") {
        setWeight(element, declaration.value, [Number(Boolean(declaration.important)), 1, 0, 0, 0, ++order]);
      }
    });
  });
  if (!weights.size) return;

  const computed = new Map<Element, { weight: number; controlled: boolean }>();
  const elements = $("*").toArray();
  for (const element of elements) {
    const current = $(element);
    const parent = current.parent()[0];
    const inherited = parent ? computed.get(parent) : undefined;
    const rule = weights.get(element);
    const tag = current.prop("tagName")?.toLowerCase();
    const weight = rule ? fontWeight(rule.value, inherited?.weight ?? 400)!
      : tag === "b" || tag === "strong" ? 700 : inherited?.weight ?? 400;
    computed.set(element, { weight, controlled: Boolean(rule || inherited?.controlled) });
  }
  // Wrap text runs, not block elements: a normal-weight child can reset a bold
  // paragraph without becoming trapped inside an enclosing strong element.
  for (const element of elements) {
    const state = computed.get(element)!;
    const current = $(element);
    if (!state.controlled || current.closest("head,style,script,title").length) continue;
    if (current.is("b,strong")) {
      (element as { name: string }).name = "span";
    }
    if (state.weight >= 600) {
      current.contents().filter((_index, node) => node.type === "text" && /\S/.test(node.data))
        .each((_index, node) => { $(node).wrap("<strong></strong>"); });
    }
  }
}
