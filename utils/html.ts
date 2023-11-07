/**
 * Split HTML text into sections that each section is less than 4000 characters
 *
 * @param htmlText The on line html text
 * @returns
 */

import {
  DOMParser,
} from "https://deno.land/x/deno_dom@v0.1.36-alpha/deno-dom-wasm.ts";

export function splitHTMLChildrenLargerThan16kByTag(htmlText: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(htmlText, "text/html");
  const result = [] as string[];
  let currentSection = "";
  for (const child of document!.body.children) {
    const text = child.outerHTML;
    if (currentSection.length + text.length > 15_000) {
      result.push(currentSection);
      currentSection = "";
    }
    currentSection += text;
  }
  if (currentSection) {
    result.push(currentSection);
  }
  return result;
}
