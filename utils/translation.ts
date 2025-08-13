import { chat } from "../utils/chatgpt.ts";
import { splitHTMLChildrenLargerThanWindowByTag } from "../utils/html.ts";
import {
    placeholderAllUrlInMarkdown,
    restoreAllUrlInMarkdown,
    splitMarkdownIfLengthLargerThanWindow,
} from "../utils/markdown.ts";


const markdownPrompt = "You are an asistant of a Minecraft mod developer. You are asked to translate the mod description into different languages by locale code. I'm going to give you markdown text. You should give me translated markdown text. Do not wrap extra markdown code block (```) to the output, and do not add locale prefix to output."
const htmlPrompt = "You are an asistant of a Minecraft mod developer. You are asked to translate the mod description into different languages by locale code. I'm going to give you html text. You should give me translated html text. Do not add locale prefix to output."
const plainPrompt = "You are an asistant of a Minecraft mod developer. You are asked to translate the mod description into different languages by locale code. Please do not add locale prefix to output."

/**
 * Translate the text into the target locale.
 * 
 * @param locale The locale to translate
 * @param text The translation text
 * @param textType The text is a markdown or html
 * @returns The translated text
 */
export async function translate(
    locale: string,
    text: string,
    textType: "text/markdown" | "text/html",
) {
    const process = async (t: string, prom: string) => {
        const resp = await chat({
            messages: [{
                role: "system",
                content: prom,
            }, {
                role: "user",
                content: "Translate following text into zh-CN:\nHello World",
            }, {
                role: "assistant",
                content: "你好世界"
            }, {
                role: "user",
                content: `Translate following text into ${locale}:\n${t}`,
            }]
        });
        if ("error" in resp) {
            return resp;
        }
        let content = resp.choices[0].message.content;
        if (content.startsWith('```' + locale)) {
            content = content.substring(('```' + locale).length);
            content = content.substring(0, content.length - 3);
        }
        if (content.startsWith(locale)) {
            content = content.substring(locale.length);
        }
        return content;
    };

    let result = "";
    if (textType === "text/markdown") {
        const holder = [] as string[];
        const transformed = placeholderAllUrlInMarkdown(text, holder);
        const chunks = splitMarkdownIfLengthLargerThanWindow(transformed);
        const outputs = await Promise.all(chunks.map(c => process(c, markdownPrompt)));
        const err = outputs.find((o) => typeof o === "object");
        if (err) return err;
        result = restoreAllUrlInMarkdown(outputs.join(""), holder);
    } else if (textType === "text/html") {
        const chunks = splitHTMLChildrenLargerThanWindowByTag(text);
        const outputs = await Promise.all(chunks.map(c => process(c, htmlPrompt)));
        const err = outputs.find((o) => typeof o === "object");
        if (err) return err;
        result = outputs.join("");
    } else {
        const translated = await process(text, plainPrompt);
        if (typeof translated === "object") return translated;
        result = translated;
    }

    return result;
}