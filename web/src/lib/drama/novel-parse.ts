import { chapterTitleFromLine, sourceHeading, splitTextIntoChapters } from "@/lib/canvas/canvas-document";
import type { DramaSourceFormat } from "@/services/api/drama";
import { readDramaSourceMarkdown, readExportedDramaReference } from "./source-reference-markdown";

// 小说导入只在浏览器内做结构化预览：拆章、清理网文平台噪音、标出需要人工确认的异常。
// 改编、拆集和建档全部交给服务端流水线。

export type ParsedChapter = { title: string; text: string; words: number };

export type NovelIssue = { kind: "no_heading" | "split_long" | "empty" | "duplicate" | "noise" | "short" | "too_long" | "invalid_export" | "reference_only"; message: string };

export type NovelAnalysis = {
    chapters: ParsedChapter[];
    referenceText?: string;
    detectedScript?: boolean;
    sourceFormat?: DramaSourceFormat;
    issues: NovelIssue[];
    words: number;
    removedNoiseLines: number;
};

export const MAX_CHAPTER_WORDS = 60_000;
const FALLBACK_CHUNK_WORDS = 3_000;
const SHORT_CHAPTER_WORDS = 300;

// 网文站点常见的插入语：网址、求票、作者有话说、广告等，只匹配整行。
const NOISE_PATTERNS = [
    /^\s*(?:https?:\/\/|www\.)\S+\s*$/i,
    /(?:求|跪求)(?:月票|推荐票|订阅|收藏|打赏)/,
    /^\s*(?:本章完|未完待续|（?本章未完.*）?)\s*$/,
    /^\s*(?:作者有话说|PS[:：]|ps[:：])/,
    /(?:手机阅读|最新章节|首发|笔趣阁|起点中文网|纵横中文网|免费阅读)/,
];

export function wordCount(text: string) {
    return Array.from(text.replace(/\s+/g, "")).length;
}

function stripNoise(text: string) {
    let removed = 0;
    const lines = text.split("\n").filter((line) => {
        const noisy = line.trim().length < 80 && NOISE_PATTERNS.some((pattern) => pattern.test(line));
        if (noisy) removed++;
        return !noisy;
    });
    return {
        text: lines
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        removed,
    };
}

/** 在段落边界把长文本切成约 target 字的块。 */
function chunkByParagraph(text: string, target: number) {
    const paragraphs = text.split(/\n+/);
    const chunks: string[] = [];
    let current: string[] = [];
    let size = 0;
    for (const paragraph of paragraphs) {
        const length = wordCount(paragraph);
        if (size > 0 && size + length > target) {
            chunks.push(current.join("\n"));
            current = [];
            size = 0;
        }
        current.push(paragraph);
        size += length;
    }
    if (current.length) chunks.push(current.join("\n"));
    return chunks.filter((chunk) => chunk.trim());
}

/** 单章原文上限（与服务端剧本提示词每章读取上限一致），超出部分的台词会丢失，所以直接拦下。 */
export const EPISODE_SOURCE_CHARS = 12_000;
/** 作品参考资料上限，与服务端资产提取的资料限额一致。 */
export const DRAMA_REFERENCE_SOURCE_CHARS = 12_000;
/** 按章合并成集时每集原文上限，与服务端 dramaEpisodeSourceRunes 一致。 */
export const EPISODE_GROUP_CHARS = 40_000;
// 自动拆分的目标字数（不含空白）：留出空白、换行与短章并入的余量，保证拆开后每章仍在 1.2 万字内。
const AUTO_SPLIT_WORDS = 9_000;

/** 与服务端一致的字符数：去掉首尾空白后的全部字符，包括换行与空格。 */
export function sourceChars(text: string) {
    return Array.from(text.trim()).length;
}

const scriptEpisodeNumber = "[0-9零〇○一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+";
const scriptTitleBoundary = "(?:$|\\s*[,，、]$|\\s*[-—–:：·.(（]|\\s+(?=[^\\s,，、]))";
const scriptEpisodeTitle = new RegExp(`^(?:正文\\s*)?(?:第\\s*${scriptEpisodeNumber}\\s*集|集\\s*${scriptEpisodeNumber}|(?:episode|ep\\.?)\\s*\\d+)${scriptTitleBoundary}`, "i");
const scriptChapterTitle = new RegExp(`^(?:正文\\s*)?第\\s*${scriptEpisodeNumber}\\s*[章回]${scriptTitleBoundary}`);
const scriptOpenerTitle = new RegExp(`^(?:序章|序幕|序言|序|前言|前记|楔子|引子|引言|开篇|prologue|preface|introduction)${scriptTitleBoundary}`, "i");
const scriptReferenceTitle = /^(?:前情提要|剧本简介)(?:\*\*|__)?\s*(?::.*)?$/;
const scriptOutlineTitle = /^(?:后续大纲|後續大綱)\s*:?$/;
const novelReferenceTitle = /^(?:作品参考资料|世界观(?:设定)?|世界设定|(?:人物|角色)(?:小[传傳]|设定|介绍|简介|描述)|(?:场景|风格|视觉风格)设[定置]|(?:地点|美术|画风|创作)设定|视觉风格|(?:故事|剧情)?梗概)(?:\*\*|__)?\s*(?::.*)?$/;
const novelReferenceWrapper = /^(?:序章|序言|前言)\s*:?$/;
const bodyHeading = /^正文(?:开始)?\s*(?::\s*(.*))?$/;
const scriptSceneStart = /^\s*(?:[△▲]\s*\S|\d+\s*[-－—–]\s*\d+(?:场|\s+\S))/;
const novelWorkTitle = /^《[^《》\n]+》$/;

function splitNumberedScript(text: string, automatic: boolean) {
    const lines = text.split("\n");
    const sections: Array<{ title: string; text: string }> = [];
    const references: string[] = [];
    let foundNumberedHeading = false;
    let markedBody = false;
    let hasReferenceHeading = false;
    type SectionKind = "story" | "reference" | "outline";
    let section: { kind: SectionKind; title: string; lines: string[] } = { kind: "story", title: "", lines: [] };
    let removedNoiseLines = 0;

    function isLeadingBookTitle(source: string) {
        return !section.title && !foundNumberedHeading && novelWorkTitle.test(sourceHeading(source).title);
    }

    function finishSection() {
        const source = section.lines.join("\n").trim();
        if (!source && !section.title) return;
        if (section.kind !== "story" || isLeadingBookTitle(source)) {
            references.push(source);
            return;
        }
        const cleaned = stripNoise(source);
        removedNoiseLines += cleaned.removed;
        sections.push({ title: section.title || "序章", text: cleaned.text });
    }

    function startStory(title: string) {
        finishSection();
        section = { kind: "story", title, lines: [] };
    }

    function addReferenceLine(line: string, kind: "reference" | "outline") {
        if (section.kind !== kind) {
            const bookTitle = isLeadingBookTitle(section.lines.join("\n").trim());
            if (!bookTitle) finishSection();
            section = { kind, title: "", lines: bookTitle ? section.lines : [] };
        }
        section.lines.push(line);
    }

    for (const [index, line] of lines.entries()) {
        const { title, candidate } = sourceHeading(line);
        const titleFits = sourceChars(line) <= 120;
        const numbered = titleFits && (scriptEpisodeTitle.test(candidate) || (!automatic && scriptChapterTitle.test(candidate)));
        const body = titleFits ? bodyHeading.exec(candidate) : null;
        const numberedBody = numbered && candidate.startsWith("正文");
        if (section.kind === "outline" && !body && !numberedBody) {
            section.lines.push(line);
            continue;
        }
        if (body) {
            markedBody = true;
            if (body[1]) {
                startStory(title);
                foundNumberedHeading ||= scriptEpisodeTitle.test(body[1]);
            } else if (section.kind !== "story") startStory("");
            continue;
        }
        if (numbered) {
            startStory(title);
            foundNumberedHeading = true;
            continue;
        }
        if (foundNumberedHeading && scriptOutlineTitle.test(candidate)) {
            hasReferenceHeading = true;
            addReferenceLine(line, "outline");
            continue;
        }
        if (!foundNumberedHeading && titleFits && scriptOpenerTitle.test(candidate)) {
            const nextLine = lines.slice(index + 1).find((following) => following.trim()) ?? "";
            const wrapsReference = !markedBody && novelReferenceWrapper.test(candidate) && isScriptReferenceTitle(sourceHeading(nextLine).candidate);
            if (wrapsReference) addReferenceLine(line, "reference");
            else startStory(title);
            continue;
        }
        if (!foundNumberedHeading && !markedBody && isScriptReferenceTitle(candidate)) {
            hasReferenceHeading = true;
            addReferenceLine(line, "reference");
            continue;
        }
        const sharedTitle = chapterTitleFromLine(line);
        if (sharedTitle) {
            startStory(sharedTitle);
            continue;
        }
        if (section.kind === "reference" && scriptSceneStart.test(line)) {
            markedBody = true;
            startStory("");
        }
        section.lines.push(line);
    }
    const recognized = automatic ? foundNumberedHeading && hasReferenceHeading : foundNumberedHeading || hasReferenceHeading;
    if (!recognized) return undefined;
    finishSection();
    return { sections, referenceText: references.join("\n\n"), removedNoiseLines };
}

function isScriptReferenceTitle(candidate: string) {
    return scriptReferenceTitle.test(candidate) || novelReferenceTitle.test(candidate);
}

function isNovelReferenceLine(line: string) {
    return isScriptReferenceTitle(sourceHeading(line).candidate);
}

function novelChapterTitle(line: string) {
    if (sourceChars(line) > 120) return null;
    const { title, candidate } = sourceHeading(line);
    return bodyHeading.exec(candidate)?.[1] ? title : chapterTitleFromLine(line);
}

function splitNovelReference(text: string) {
    const lines = text.split("\n");
    // 开头的通用序章标题只有在紧接资料小节时才随参考保留，真正的序章从原处开始改编。
    const firstSection = novelWorkTitle.test(sourceHeading(lines[0]).title) ? lines.findIndex((line, index) => index > 0 && line.trim()) : 0;
    const wrapped = firstSection >= 0 && novelReferenceWrapper.test(sourceHeading(lines[firstSection]).candidate) && isNovelReferenceLine(lines.slice(firstSection + 1).find((line) => line.trim()) ?? "");
    const chapterStart = lines.findIndex((line, index) => (!wrapped || index !== firstSection) && (chapterTitleFromLine(line) !== null || scriptSceneStart.test(line) || (sourceChars(line) <= 120 && bodyHeading.test(sourceHeading(line).candidate))));
    const prefixEnd = chapterStart < 0 ? lines.length : chapterStart;
    const prefix = lines.slice(0, prefixEnd);
    const referenceStart = wrapped ? 0 : prefix.findIndex(isNovelReferenceLine);
    if (referenceStart < 0) return undefined;

    const marker = chapterStart < 0 ? null : bodyHeading.exec(sourceHeading(lines[chapterStart]).candidate);
    const chapterLines = lines.slice(marker && !marker[1] ? chapterStart + 1 : prefixEnd);

    // 第一处设定标题前的文字也可能是开场正文。只将单独出现的书名随设定保存。
    const leading = prefix.slice(0, referenceStart);
    const nameOnly = novelWorkTitle.test(sourceHeading(leading.join("\n")).title);
    return {
        text: (nameOnly ? chapterLines : [...leading, ...chapterLines]).join("\n"),
        referenceText: prefix
            .slice(nameOnly ? 0 : referenceStart)
            .join("\n")
            .trim(),
    };
}

/**
 * perEpisode：每个标题段落就是一集（剧本、分镜或逐集制作的小说）。
 * 此时不按段落自动切块、不合并短章，超过单集上限的段落标出来让用户拆分。
 * script：有明确集标题时，将集前资料及明确标记的后续大纲保留供资产提取。
 * script 为 auto 时，同时需要集号和明确的参考资料标题。
 * novelReference：识别正文标题前明确标注的小说设定。
 */
export function analyzeNovel(raw: string, options: { perEpisode?: boolean; script?: boolean | "auto"; novelReference?: boolean } = {}): NovelAnalysis {
    const linesNormalized = raw.replace(/\r\n?/g, "\n");
    const markdown = readDramaSourceMarkdown(linesNormalized.trimStart());
    if (markdown === null) {
        const issue: NovelIssue = { kind: "invalid_export", message: "作品导出文件的分集标记不完整，请重新下载后导入" };
        return { chapters: [], issues: [issue], words: 0, removedNoiseLines: 0 };
    }
    const issues: NovelIssue[] = [];
    const trimmed = markdown ? "" : linesNormalized.trim();
    const legacy = markdown ? undefined : readExportedDramaReference(trimmed);
    const normalized = (legacy?.text ?? trimmed).replace(/\u3000/g, "  ");
    const script = !markdown && options.script ? splitNumberedScript(normalized, options.script === "auto") : undefined;
    const novel = !markdown && options.novelReference && options.script !== true && !script ? splitNovelReference(normalized) : undefined;
    const referenceText = markdown ? markdown.referenceText : [legacy?.referenceText, script?.referenceText || novel?.referenceText].filter(Boolean).join("\n\n") || undefined;
    const sourceMetadata = {
        ...(referenceText !== undefined ? { referenceText } : {}),
        ...(script && options.script === "auto" ? { detectedScript: true } : {}),
        ...(markdown ? { sourceFormat: markdown.sourceFormat } : {}),
    };
    const perEpisode = options.perEpisode || options.script === true || Boolean(script);
    let sections = markdown?.chapters ?? script?.sections;
    let removedNoiseLines = script?.removedNoiseLines ?? 0;
    if (!sections) {
        const cleaned = stripNoise(novel?.text ?? normalized);
        removedNoiseLines = cleaned.removed;
        sections = splitTextIntoChapters(cleaned.text, novel ? novelChapterTitle : chapterTitleFromLine).map((section) => ({ title: section.title, text: section.plainText }));
        const detectedHeading = sections.length > 1 || (sections[0] && sections[0].title !== "第 1 章");
        if (!perEpisode && !detectedHeading && wordCount(cleaned.text) > FALLBACK_CHUNK_WORDS * 1.5) {
            sections = chunkByParagraph(cleaned.text, FALLBACK_CHUNK_WORDS).map((text, index) => ({ title: `第 ${index + 1} 段`, text }));
            issues.push({ kind: "no_heading", message: `没有识别到章节标题，已按段落切成 ${sections.length} 段，改编时会自动合并成集` });
        }
    }
    if (removedNoiseLines > 0) issues.unshift({ kind: "noise", message: `已移除 ${removedNoiseLines} 行网址、求票等平台插入语` });

    const chapters: ParsedChapter[] = [];
    let splitCount = 0;
    for (const section of sections) {
        const words = wordCount(section.text);
        // 交给模型分集时超长章节在段落处拆开：剧本每章最多读取 1.2 万字，超出部分会丢；逐集制作时由用户自己拆。
        const tooLong = perEpisode ? words > MAX_CHAPTER_WORDS : sourceChars(section.text) > EPISODE_SOURCE_CHARS;
        if (!markdown && tooLong) {
            const parts = chunkByParagraph(section.text, perEpisode ? Math.floor(MAX_CHAPTER_WORDS * 0.8) : AUTO_SPLIT_WORDS);
            parts.forEach((text, index) => chapters.push({ title: `${section.title}（${index + 1}/${parts.length}）`, text, words: wordCount(text) }));
            splitCount++;
            continue;
        }
        chapters.push({ title: section.title, text: section.text, words });
    }
    if (splitCount) issues.push({ kind: "split_long", message: `${splitCount} 个超长章节已在段落处拆开` });

    const empty = chapters.filter((chapter) => chapter.words === 0).length;
    if (empty) issues.push({ kind: "empty", message: `${empty} 个章节没有正文，已跳过` });
    const nonEmpty = chapters.filter((chapter) => chapter.words > 0);
    if (referenceText && !nonEmpty.length) issues.unshift({ kind: "reference_only", message: "只识别到作品参考资料。请补充正式剧情正文，用“正文”或章节标题标出起点。" });

    const seen = new Map<string, number>();
    for (const chapter of nonEmpty) seen.set(chapter.title, (seen.get(chapter.title) || 0) + 1);
    const duplicated = [...seen.values()].filter((count) => count > 1).length;
    if (duplicated) issues.push({ kind: "duplicate", message: `${duplicated} 个章节标题重复，可能是重复粘贴，请确认` });

    if (perEpisode || markdown) {
        const tooLong = nonEmpty.filter((chapter) => sourceChars(chapter.text) > EPISODE_SOURCE_CHARS).length;
        if (tooLong) issues.push({ kind: "too_long", message: `${tooLong} 集原文超过 ${EPISODE_SOURCE_CHARS / 10_000} 万字，请用“第 N 集”标题拆成多集，或只先放第 1 集` });
        return {
            chapters: nonEmpty,
            ...sourceMetadata,
            issues,
            words: nonEmpty.reduce((sum, chapter) => sum + chapter.words, 0),
            removedNoiseLines,
        };
    }

    const merged = mergeShortChapters(nonEmpty);
    if (merged.count) issues.push({ kind: "short", message: `${merged.count} 个不足 ${SHORT_CHAPTER_WORDS} 字的短章（如序章、楔子）已并入相邻章节` });

    return { chapters: merged.chapters, ...sourceMetadata, issues, words: merged.chapters.reduce((sum, chapter) => sum + chapter.words, 0), removedNoiseLines };
}

/**
 * 序章、楔子、作者的话这类短章单独成章没有改编价值，还会让分集过碎：
 * 并入下一章开头（最后一章则并入上一章），标题保留为“序章 + 第一章”。
 */
function mergeShortChapters(chapters: ParsedChapter[]) {
    if (chapters.length < 2) return { chapters, count: 0 };
    const result: ParsedChapter[] = [];
    let carry: ParsedChapter | null = null;
    let count = 0;
    for (const chapter of chapters) {
        const current: ParsedChapter = carry ? { title: `${carry.title} · ${chapter.title}`, text: `${carry.text}\n\n${chapter.text}`, words: carry.words + chapter.words } : chapter;
        carry = null;
        if (current.words < SHORT_CHAPTER_WORDS) {
            carry = current;
            count++;
            continue;
        }
        result.push(current);
    }
    if (carry) {
        const last = result.pop();
        result.push(last ? { title: last.title, text: `${last.text}\n\n${carry.text}`, words: last.words + carry.words } : carry);
    }
    return { chapters: result, count };
}

/** 从文件名推导作品名：去掉扩展名与常见的“全本/完结/TXT”后缀。 */
export function titleFromFileName(name: string) {
    return name
        .replace(/\.[^.]+$/, "")
        .replace(/[（(【[]?(?:全本|全集|完结|完本|精校|txt|TXT)[)）】\]]?/g, "")
        .replace(/[_\-\s]+$/g, "")
        .trim()
        .slice(0, 40);
}
