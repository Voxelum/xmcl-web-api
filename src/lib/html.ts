import { parse } from "node-html-parser";

/**
 * Split HTML into chunks of roughly `windowSize` characters, breaking only at
 * top-level element boundaries so tags are never split mid-way.
 *
 * Uses `node-html-parser`, which is pure JS and runs on Deno, Node/Azure and
 * Cloudflare Workers (unlike the Deno-only `deno_dom`).
 */
export function splitHTMLChildrenLargerThanWindowByTag(
  htmlText: string,
  windowSize = 15_000,
): string[] {
  const root = parse(htmlText);
  const result: string[] = [];
  let currentSection = "";
  for (const child of root.childNodes) {
    const text = child.toString();
    if (currentSection.length + text.length > windowSize) {
      if (currentSection) result.push(currentSection);
      currentSection = "";
    }
    currentSection += text;
  }
  if (currentSection) {
    result.push(currentSection);
  }
  return result;
}
