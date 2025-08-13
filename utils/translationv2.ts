import { chat } from "./chatgpt.ts";
import { splitHTMLChildrenLargerThanWindowByTag } from "./html.ts";
import {
    placeholderAllUrlInMarkdown,
    restoreAllUrlInMarkdown,
    splitMarkdownIfLengthLargerThanWindow,
} from "./markdown.ts";


/**
 * Translate the text into the target locale.
 * 
 * @param locale The locale to translate
 * @param text The translation text
 * @param textType The text is a markdown or html
 * @returns The translated text
 */
export async function translatev2(
    locale: string,
    text: string,
    textType: "text/markdown" | "text/html",
) {
    const process = async (t: string) => {
        const resp = await chat({
            messages: [{
                role: "user",
                content: t,
            }],
            api: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            model: 'qwen-mt-turbo',
            translation_options: {
                "source_lang": "auto",
                "target_lang": locale,
                "domains": 'The content is about Minecraft Mod/ResourcePack/Modpack/ShaderPack or other Minecraft related resources. Please keep the language style delightful for gamers.'
            },
            key: Deno.env.get("QWEN_API_KEY")!,
        });
        if ("error" in resp) {
            return resp;
        }
        return resp.choices[0].message.content;
    };

    let result = "";
    if (textType === "text/markdown") {
        const holder = [] as string[];
        const transformed = placeholderAllUrlInMarkdown(text, holder);
        const chunks = splitMarkdownIfLengthLargerThanWindow(transformed, 2_000);
        const outputs = await Promise.all(chunks.map(c => process(c)));
        const err = outputs.find((o) => typeof o === "object");
        if (err) return err;
        result = restoreAllUrlInMarkdown(outputs.join(""), holder);
    } else if (textType === "text/html") {
        const chunks = splitHTMLChildrenLargerThanWindowByTag(text, 2_000);
        const outputs = await Promise.all(chunks.map(c => process(c)));
        const err = outputs.find((o) => typeof o === "object");
        if (err) return err;
        result = outputs.join("");
    } else {
        const translated = await process(text);
        if (typeof translated === "object") return translated;
        result = translated;
    }

    return result;
}