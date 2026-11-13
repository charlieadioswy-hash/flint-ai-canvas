import { decodeNovelText } from "@/lib/canvas/canvas-document";
import { listZipEntries, readZipEntry } from "@/lib/zip-entries";

/** 短剧步骤式导入的上传上限；页面说明与读取校验共用。 */
export const DRAMA_SOURCE_FILE_MAX_BYTES = 30 * 1024 * 1024;

/** 正文 XML 展开上限。图片等其他条目只看目录，不展开到内存。 */
const DRAMA_SOURCE_XML_MAX_BYTES = 8 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown"]);

export async function readDramaSourceFile(file: File): Promise<string> {
    if (file.size > DRAMA_SOURCE_FILE_MAX_BYTES) {
        throw new Error(`文件超过 ${formatDramaSourceFileSize(DRAMA_SOURCE_FILE_MAX_BYTES)}，请拆分后再导入`);
    }
    if (file.size === 0) throw new Error("文件是空的，没有可导入的正文");

    const extension = fileExtension(file.name);
    if (extension === "doc") throw new Error("不支持旧版 Word 文件（.doc），请在 Word 中另存为 DOCX 后再导入");
    if (extension === "docx") return readDocxText(file);
    if (TEXT_EXTENSIONS.has(extension) || extension === "") return readPlainText(file);
    throw new Error("只支持 TXT、MD、Markdown 和 DOCX 文件");
}

export function formatDramaSourceFileSize(bytes: number) {
    return `${Math.round(bytes / (1024 * 1024))}MB`;
}

async function readPlainText(file: File) {
    return requireText(decodeNovelText(await file.arrayBuffer()));
}

async function readDocxText(file: File) {
    let entries;
    try {
        entries = await listZipEntries(file);
    } catch {
        throw new Error("DOCX 已损坏，无法读取正文");
    }
    const document = entries.find((entry) => entry.name.replace(/^\/+/, "").toLowerCase() === "word/document.xml");
    if (!document) throw new Error("DOCX 已损坏，无法读取正文");
    if (document.size > DRAMA_SOURCE_XML_MAX_BYTES) throw new Error("DOCX 正文过大，无法导入");

    let xml: string;
    try {
        const blob = await readZipEntry(file, document, "application/xml");
        // 存储条目的实际大小跟中央目录声明的 size 不是一回事，改小声明值不能绕过展开上限。
        if (blob.size > DRAMA_SOURCE_XML_MAX_BYTES) throw new Error("DOCX 正文过大，无法导入");
        xml = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
        if (error instanceof Error && error.message === "DOCX 正文过大，无法导入") throw error;
        throw new Error("DOCX 已损坏，无法读取正文");
    }
    return requireText(extractDocxBody(xml));
}

function extractDocxBody(documentXml: string) {
    const document = parseXml(documentXml);
    const body = firstChild(document.documentElement, "body") ?? document.getElementsByTagName("w:body")[0];
    if (!body) throw new Error("DOCX 已损坏，无法读取正文");
    return blockText(body);
}

/** 段落、表格、内容控件按文档顺序展开；单元格里的嵌套表和控件走同一条路径。 */
function blockText(node: Element) {
    const parts: string[] = [];
    for (const child of elementChildren(node)) {
        if (child.localName === "p") parts.push(paragraphText(child));
        else if (child.localName === "tbl") parts.push(tableText(child));
        else if (child.localName === "sdt" || child.localName === "sdtContent") parts.push(blockText(child));
    }
    return joinBlocks(parts);
}

function paragraphText(paragraph: Element) {
    const pieces: string[] = [];
    collectRunText(paragraph, pieces);
    return pieces.join("");
}

/** 按出现顺序收集 w:t / 换行 / 制表符，跳过修订删除、域代码和绘图。 */
function collectRunText(node: Element, pieces: string[]) {
    for (const child of elementChildren(node)) {
        if (child.localName === "t") pieces.push(child.textContent ?? "");
        else if (child.localName === "tab") pieces.push("\t");
        else if (child.localName === "br" || child.localName === "cr") pieces.push("\n");
        else if (child.localName === "instrText" || child.localName === "delText" || child.localName === "drawing" || child.localName === "pict" || child.localName === "object") continue;
        else collectRunText(child, pieces);
    }
}

function tableText(table: Element) {
    const rows: string[] = [];
    for (const row of elementChildren(table).filter((child) => child.localName === "tr")) {
        const cells = elementChildren(row)
            .filter((child) => child.localName === "tc")
            .map((cell) => blockText(cell));
        if (cells.some((cell) => cell.length > 0)) rows.push(cells.join("\t"));
    }
    return rows.join("\n");
}

function joinBlocks(parts: string[]) {
    return parts
        .map((part) => part.replace(/[ \t]+\n/g, "\n").trimEnd())
        .filter((part) => part.trim().length > 0)
        .join("\n");
}

function elementChildren(node: ParentNode) {
    return Array.from(node.childNodes).filter((child): child is Element => child instanceof Element);
}

function firstChild(node: Element | null, localName: string) {
    if (!node) return null;
    return elementChildren(node).find((child) => child.localName === localName) ?? null;
}

function parseXml(xml: string) {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("DOCX 已损坏，无法读取正文");
    return document;
}

function requireText(text: string) {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
    if (!normalized.trim()) throw new Error("文件里没有可导入的正文");
    return normalized.trim();
}

function fileExtension(name: string) {
    const base = name.split(/[/\\]/).pop() ?? name;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return "";
    return base.slice(dot + 1).toLowerCase();
}
