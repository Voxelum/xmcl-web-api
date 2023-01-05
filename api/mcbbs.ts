import { defineApi } from "../type.ts";
import {
  DOMParser,
  Element,
} from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

interface Item {
  title: string;
  tags: string[];
  titleStyle: string;
  category: string;
  link: string;
  author: string;
  date: string;
  reply: string;
  view: string;
  replayAuthor: string;
  replayDate: string;
}

function parseNews(body: string) {
  const allItems = [] as Item[];

  const document = new DOMParser().parseFromString(body, "text/html");

  if (document) {
    const threadlisttableid = document.getElementById(
      "threadlisttableid",
    ) as Element;
    if (!threadlisttableid) {
      return allItems;
    }
    let foundSeparator = false;
    for (const tbody of threadlisttableid.children) {
      if (tbody.tagName !== "TBODY") continue;
      if (tbody.id === "separatorline") {
        foundSeparator = true;
        continue;
      }
      if (!foundSeparator) {
        continue;
      }
      const tr = tbody.children[0] as Element;
      if (
        !tr.children?.[0]?.children?.[0]?.tagName ||
        tr.children[0].children[0].tagName === "IMG"
      ) {
        continue;
      }
      const link = tr.children[0].querySelector("a") as Element;
      const linkString = link.getAttribute("href");
      const common = tr.children[1];
      const tags = [] as string[];
      let category = "";
      let title = "";
      let titleStyle = "";
      for (const c of common.children) {
        if (c.tagName === "A" && c.className !== "s xst") continue;
        if (c.tagName === "A") {
          title = c.textContent;
          titleStyle = c.getAttribute("style") ?? "";
          continue;
        }
        if (c.tagName === "EM") {
          category = c.textContent;
          continue;
        }
        if (c.tagName === "IMG") {
          tags.push(c.getAttribute("title") || c.getAttribute("alt") || "");
        }
      }
      const by = tr.children[2];
      const author = by.querySelector("cite")?.children[0].textContent ?? "";
      const date = by.querySelector("span")?.textContent ?? "";

      const num = tr.children[3];
      const reply = num.firstChild.textContent;
      const view = num.lastChild.textContent;

      const by2 = tr.children[4];
      const replayAuthor = by2.querySelector("cite")?.children[0].textContent ??
        "";
      const replayDate = by2.querySelector("span")?.getAttribute("title") ?? "";

      allItems.push({
        title,
        tags,
        titleStyle,
        category,
        link: linkString ?? "",
        author,
        date,
        reply,
        view,
        replayAuthor,
        replayDate,
      });
    }
  }
  return allItems;
}

export default defineApi((router) => {
  router.get("/mcbbs", async (ctx) => {
    const resp = await fetch("https://www.mcbbs.net/forum-news-1.html");
    if (resp.status === 200) {
      const body = await resp.text();
      const result = parseNews(body);
      ctx.response.status = 200;
      ctx.response.body = result;
    } else {
      ctx.response.status = resp.status;
    }
  });
});
