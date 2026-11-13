import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { Window } from "happy-dom";

import { DRAMA_SOURCE_FILE_MAX_BYTES, readDramaSourceFile } from "../src/pages/projects/drama-source-file";

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function docxFile(name: string, documentXml: string, extra: Record<string, Uint8Array> = {}) {
    const archive = zipSync({
        "[Content_Types].xml": strToU8(contentTypes),
        "_rels/.rels": strToU8(relationships),
        "word/document.xml": strToU8(documentXml),
        ...extra,
    });
    return new File([archive], name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function documentXml(body: string) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;
}

function paragraph(...runs: string[]) {
    return `<w:p>${runs.map((text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`).join("")}</w:p>`;
}

describe("readDramaSourceFile", () => {
    const previous = { DOMParser: globalThis.DOMParser, Element: globalThis.Element };

    beforeAll(() => {
        const window = new Window();
        globalThis.DOMParser = window.DOMParser;
        globalThis.Element = window.Element;
    });

    afterAll(() => {
        globalThis.DOMParser = previous.DOMParser;
        globalThis.Element = previous.Element;
    });

    test("按文档原序提取交错的段落和表格，并拼接拆开的文本", async () => {
        const body = [
            paragraph("第一场", " 夜"),
            `<w:tbl>
                <w:tr>
                    <w:tc>${paragraph("角色")}</w:tc>
                    <w:tc>${paragraph("台词")}</w:tc>
                </w:tr>
                <w:tr>
                    <w:tc>${paragraph("阿")}${paragraph("宁")}</w:tc>
                    <w:tc>${paragraph("你&amp;我都别回头。")}<w:p><w:r><w:t>她说：</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>「走。」</w:t></w:r></w:p></w:tc>
                </w:tr>
            </w:tbl>`,
            paragraph("第二场"),
        ].join("");
        const text = await readDramaSourceFile(docxFile("剧本.docx", documentXml(body)));

        expect(text).toBe(["第一场 夜", "角色\t台词", "阿\n宁\t你&我都别回头。\n她说：\n「走。」", "第二场"].join("\n"));
    });

    test("保留 XML 实体、制表符和软换行，不改写正文", async () => {
        const body = `<w:p><w:r><w:t>甲&lt;乙&gt;</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>丙&amp;丁</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>下一行</w:t></w:r></w:p>`;
        expect(await readDramaSourceFile(docxFile("台词.docx", documentXml(body)))).toBe("甲<乙>\t丙&丁\n下一行");
    });

    test("跳过内嵌图片，不把图片字节展开进正文", async () => {
        const image = new Uint8Array(256 * 1024);
        image.fill(0x7f);
        const body = `${paragraph("开场")}<w:p><w:r><w:drawing><w:t>不应读出图片节点里的字</w:t></w:drawing><w:t>旁白</w:t></w:r></w:p>`;
        const text = await readDramaSourceFile(
            docxFile("带图.docx", documentXml(body), {
                "word/media/image1.png": image,
            }),
        );
        expect(text).toBe("开场\n旁白");
        expect(text).not.toContain("不应读出");
    });

    test("解码 TXT、Markdown 的 UTF-16 与 GB18030", async () => {
        const utf16 = new Uint8Array([0xff, 0xfe, 0x2c, 0x7b, 0x00, 0x4e, 0xe0, 0x7a]);
        expect(await readDramaSourceFile(new File([utf16], "小说.txt"))).toBe("第一章");

        const markdown = new TextEncoder().encode("# 标题\n\n正文");
        expect(await readDramaSourceFile(new File([markdown], "大纲.markdown"))).toBe("# 标题\n\n正文");

        const gb18030 = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
        expect(await readDramaSourceFile(new File([gb18030], "旧稿.md"))).toBe("第一章");
    });

    test("拒绝空文件、纯空白、旧 doc、超限、损坏和不支持的类型", async () => {
        await expect(readDramaSourceFile(new File([], "空.txt"))).rejects.toThrow("文件是空的");
        await expect(readDramaSourceFile(new File([" \n\t"], "空白.md"))).rejects.toThrow("没有可导入的正文");
        await expect(readDramaSourceFile(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], "旧稿.doc"))).rejects.toThrow("另存为 DOCX");
        await expect(readDramaSourceFile(new File(["剧本"], "剧本.pdf"))).rejects.toThrow("只支持");

        const oversized = new File([new Uint8Array(1)], "太大.txt");
        Object.defineProperty(oversized, "size", { value: DRAMA_SOURCE_FILE_MAX_BYTES + 1 });
        await expect(readDramaSourceFile(oversized)).rejects.toThrow("30MB");

        await expect(readDramaSourceFile(new File(["not a zip"], "坏.docx"))).rejects.toThrow("DOCX 已损坏");
        await expect(readDramaSourceFile(docxFile("缺正文.docx", documentXml(""), { "word/document.xml": strToU8("") }))).rejects.toThrow("DOCX 已损坏");

        const blankDocx = docxFile("空白.docx", documentXml("<w:p><w:r><w:t>   </w:t></w:r></w:p>"));
        await expect(readDramaSourceFile(blankDocx)).rejects.toThrow("没有可导入的正文");
    });

    test("单元格里的嵌套表和内容控件按顺序保留，后面的段落不丢", async () => {
        const nested = `<w:tbl><w:tr><w:tc>${paragraph("外层")}<w:tbl><w:tr><w:tc><w:sdt><w:sdtContent>${paragraph("内层台词")}</w:sdtContent></w:sdt></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`;
        const text = await readDramaSourceFile(docxFile("嵌套.docx", documentXml(`${nested}${paragraph("收场")}`)));
        expect(text).toBe("外层\n内层台词\n收场");
    });

    test("声明展开大小被改小的存储正文仍按实际字节拒绝", async () => {
        const archive = zipSync(
            {
                "[Content_Types].xml": strToU8(contentTypes),
                "_rels/.rels": strToU8(relationships),
                "word/document.xml": strToU8(documentXml(paragraph("A".repeat(9 * 1024 * 1024)))),
            },
            { level: 0 },
        );
        shrinkCentralDirectorySize(archive, "word/document.xml");
        await expect(readDramaSourceFile(new File([archive], "篡改.docx"))).rejects.toThrow("正文过大");
    });
});

function shrinkCentralDirectorySize(archive: Uint8Array, name: string) {
    const encoded = strToU8(name);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    for (let index = 0; index + 46 + encoded.length <= archive.length; index += 1) {
        if (view.getUint32(index, true) !== 0x02014b50) continue;
        const nameLength = view.getUint16(index + 28, true);
        if (nameLength !== encoded.length || !encoded.every((byte, offset) => archive[index + 46 + offset] === byte)) continue;
        view.setUint32(index + 24, 64, true);
        return;
    }
    throw new Error(`找不到中央目录条目 ${name}`);
}
