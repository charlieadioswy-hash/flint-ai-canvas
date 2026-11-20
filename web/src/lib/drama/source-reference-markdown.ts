import type { DramaChapterInput, DramaSourceFormat } from "@/services/api/drama";

type DramaSourceMarkdown = { sourceFormat: DramaSourceFormat; referenceText?: string; chapters: DramaChapterInput[] };

const sourceHeader = "<!-- yingce-drama-source:";

function chapterMarker(id: string) {
    return `<!-- yingce-drama-chapter:${id} -->`;
}

function formatDramaSourceReference(referenceText?: string) {
    // 整部导出包含资料区，空资料区表示替换时清除旧资料。单集导出省略资料区。
    if (referenceText === undefined) return "";
    // 资料正文允许包含 Markdown 围栏和「正文」标题。
    const longestFence = (referenceText.match(/~{3,}/g) || []).reduce((max, run) => Math.max(max, run.length), 2);
    const fence = "~".repeat(longestFence + 1);
    return `# 作品参考资料\n\n${fence}\n${referenceText}\n${fence}\n\n# 正文\n\n`;
}

export function readExportedDramaReference(text: string) {
    const match = /^# 作品参考资料\n\n(~{3,})\n([\s\S]*?)\n\1\n\n# 正文\n+/.exec(text);
    if (!match || !text.slice(match[0].length).trim()) return undefined;
    return { referenceText: match[2], text: text.slice(match[0].length) };
}

export function formatDramaSourceMarkdown({ sourceFormat, referenceText, chapters }: DramaSourceMarkdown) {
    // 正文可包含 Markdown 注释和任意分隔线，选择没有出现在正文中的分集标记。
    const usedMarkers = new Set<string>();
    for (const { text } of chapters) {
        for (const match of text.matchAll(/<!-- yingce-drama-chapter:(\d+) -->/g)) usedMarkers.add(match[1]);
    }
    let markerId = 0;
    while (usedMarkers.has(String(markerId))) markerId++;
    const marker = chapterMarker(String(markerId));
    const reference = formatDramaSourceReference(referenceText);
    const sections = chapters.map(({ title, text }) => `# ${title.replaceAll("&", "&amp;").replace(/\r\n?|\n/g, "&#10;")}\n\n${text}`);
    return `${sourceHeader}v1 ${sourceFormat} ${markerId} ${chapters.length} -->\n\n${reference}${marker}\n\n${sections.join(`\n\n${marker}\n\n`)}\n\n${marker}`;
}

// undefined 是普通文档，null 是无法完整还原的作品导出文件。
export function readDramaSourceMarkdown(text: string): DramaSourceMarkdown | null | undefined {
    if (!text.startsWith(sourceHeader)) return undefined;
    const header = /^<!-- yingce-drama-source:v1 (novel|script|storyboard) (\d+) (\d+) -->\n\n/.exec(text);
    if (!header) return null;
    const marker = chapterMarker(header[2]);
    const content = text.slice(header[0].length).trimEnd();
    const reference = readExportedDramaReference(content);
    const body = reference?.text ?? content;
    const opening = `${marker}\n\n`;
    const closing = `\n\n${marker}`;
    if (!body.startsWith(opening) || !body.endsWith(closing)) return null;
    const sections = body.slice(opening.length, -closing.length).split(`\n\n${marker}\n\n`);
    if (sections.length !== Number(header[3])) return null;
    const chapters: DramaChapterInput[] = [];
    for (const section of sections) {
        const chapter = /^# ([^\n]*)\n\n/.exec(section);
        if (!chapter) return null;
        chapters.push({ title: chapter[1].replaceAll("&#10;", "\n").replaceAll("&amp;", "&"), text: section.slice(chapter[0].length) });
    }
    return { sourceFormat: header[1] as DramaSourceFormat, referenceText: reference?.referenceText, chapters };
}
