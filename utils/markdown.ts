export function splitMarkdowntoSections(markdownText: string): string[] {
  const sections = markdownText.split(/(?=^## )/gm);
  return sections;
}

export function splitMarkdownIfLengthLargerThan16k(
  markdownText: string,
): string[] {
  const sections = splitMarkdowntoSections(markdownText);
  const result: string[] = [];
  let currentSection = "";
  for (const section of sections) {
    if (currentSection.length + section.length > 10_000) {
      result.push(currentSection);
      currentSection = section;
    } else {
      currentSection += section;
    }
  }
  result.push(currentSection);
  return result;
}

export function placeholderAllUrlInMarkdown(
  markdownText: string,
  holder: string[],
): string {
  const result = markdownText.replace(
    /\[(.+?)\]\((.+?)\)/g,
    (_, text, url) => {
      const transformed = `[${text}](${holder.length})`;
      holder.push(url);
      return transformed;
    },
  );
  return result;
}

export function restoreAllUrlInMarkdown(
  markdownText: string,
  holder: string[],
): string {
  const result = markdownText.replace(
    /\[(.+?)\]\((\d+)\)/g,
    (_, text, index) => {
      const url = holder[parseInt(index)];
      return `[${text}](${url})`;
    },
  );
  return result;
}
