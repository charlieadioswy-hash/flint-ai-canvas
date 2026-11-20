import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeNovel, MAX_CHAPTER_WORDS, titleFromFileName } from "./novel-parse";
import { formatDramaSourceMarkdown } from "./source-reference-markdown";

const body = (text: string) => text.repeat(60);

test("splits chapters and strips platform noise lines", () => {
    const text = ["第一章 陨落的天才", body("萧炎站在广场上。"), "求月票！", "www.example.com", "第二章 退婚", body("纳兰嫣然来了。")].join("\n");
    const result = analyzeNovel(text);
    assert.equal(result.chapters.length, 2);
    assert.equal(result.chapters[0].title, "第一章 陨落的天才");
    assert.equal(result.removedNoiseLines, 2);
    assert.ok(!result.chapters[0].text.includes("月票"));
    assert.ok(result.issues.some((issue) => issue.kind === "noise"));
});

test("chunks headingless text by paragraphs", () => {
    const paragraph = "这是一段没有章节标题的正文。".repeat(40);
    const result = analyzeNovel(Array.from({ length: 30 }, () => paragraph).join("\n"));
    assert.ok(result.chapters.length > 1);
    assert.ok(result.issues.some((issue) => issue.kind === "no_heading"));
});

test("splits chapters above the server limit", () => {
    const paragraph = "字".repeat(1000);
    const body = Array.from({ length: 80 }, () => paragraph).join("\n");
    const result = analyzeNovel(`第一章 长\n${body}`);
    assert.ok(result.chapters.length >= 2);
    assert.ok(result.chapters.every((chapter) => chapter.words <= MAX_CHAPTER_WORDS));
});

test("merges tiny chapters such as a short prologue into the next chapter", () => {
    const result = analyzeNovel(["序章", "穿越了。", "第一章 零悟性", body("测试石碑毫无反应。"), "第二章 扫茅厕", body("夜里系统响起。")].join("\n"));
    assert.equal(result.chapters.length, 2);
    assert.equal(result.chapters[0].title, "序章 · 第一章 零悟性");
    assert.ok(result.chapters[0].text.startsWith("穿越了。"));
    assert.ok(result.issues.some((issue) => issue.kind === "short"));
});

test("flags duplicated chapter titles", () => {
    const result = analyzeNovel(`第一章 开端\n${body("甲乙丙")}\n第一章 开端\n${body("丁戊己")}`);
    assert.ok(result.issues.some((issue) => issue.kind === "duplicate"));
});

test("keeps front matter and a separately labelled future outline as script reference", () => {
    const introduction = "《我们家小区又穿越了》\n梗概\n小区和住户穿越到了荒野。\n人物小传\n1. 秦子文\n年龄：26岁";
    const outline = "后续大纲：\n第六集，\n兄弟俩在河边捕鱼。\n第七集（过渡章）\n筹备业主大会。";
    const result = analyzeNovel([introduction, "前几集试阅：", "第1集", "1-1 小区边缘 日 外\n△秦子文与弟弟采摘桑葚。", "## 【第二集】", "△住户回到小区。", outline].join("\n"), { script: true });

    assert.equal(result.referenceText, `${introduction}\n前几集试阅：\n\n${outline}`);
    assert.deepEqual(
        result.chapters.map(({ title, text }) => ({ title, text })),
        [
            { title: "第1集", text: "1-1 小区边缘 日 外\n△秦子文与弟弟采摘桑葚。" },
            { title: "【第二集】", text: "△住户回到小区。" },
        ],
    );
});

test("keeps a numbered screen prologue and retains the single-script fallback", () => {
    const numbered = analyzeNovel("序章\n人物设定\n介绍主角和前情。\n第0集（正式序章）\n秦子文打开窗户。\nEpisode 1: Crossing\n小区出现在荒野。", { script: true });
    assert.equal(numbered.referenceText, "序章\n人物设定\n介绍主角和前情。");
    assert.deepEqual(
        numbered.chapters.map((chapter) => chapter.title),
        ["第0集（正式序章）", "Episode 1: Crossing"],
    );

    const script = "1-1 小区边缘 日 外\n△秦子文打开窗户。";
    const single = analyzeNovel(script, { script: true });
    assert.equal(single.referenceText, undefined);
    assert.equal(single.chapters.length, 1);
    assert.equal(single.chapters[0].text, script);
});

test("keeps narrative before the first numbered episode in the chapter directory", () => {
    const narrative = "△罗森跑进灯塔，抓住坠落的信使。";
    const settings = "人物小传\n罗森是守塔人。";
    for (const title of ["序章", "序章（夜至）", "正文"]) {
        for (const script of [true, "auto"] as const) {
            const result = analyzeNovel(`${settings}\n${title}\n${narrative}\n第1集\n罗森背着信使下楼。`, { script, perEpisode: true });
            assert.equal(result.referenceText, settings);
            assert.deepEqual(
                result.chapters.map(({ title, text }) => ({ title, text })),
                [
                    { title: title === "正文" ? "序章" : title, text: narrative },
                    { title: "第1集", text: "罗森背着信使下楼。" },
                ],
            );
        }
    }
    const unlabelled = analyzeNovel(`${narrative}\n${settings}\n第1集\n罗森背着信使下楼。`, { script: true });
    assert.equal(unlabelled.chapters[0].text, narrative);
    assert.equal(unlabelled.referenceText, settings);
    const standalone = analyzeNovel(`${narrative}\n第1集\n罗森背着信使下楼。`, { script: true });
    assert.equal(standalone.chapters[0].text, narrative);
    assert.equal(standalone.referenceText, undefined);
});

test("resumes script episodes when an outline ends at a 正文 marker", () => {
    const raw = "第0集\n罗森跑向码头。\n后续大纲\n第2集\n安排登塔。\n正文：\n第1集\n罗森落水。\n后续大纲：\n第3集\n计划寻找证人。\n正文 第2集·获救\n船把罗森救了起来。\n后续大纲\n第3集\n准备返港。";
    const result = analyzeNovel(raw, { script: true });
    assert.deepEqual(
        result.chapters.map(({ title, text }) => ({ title, text })),
        [
            { title: "第0集", text: "罗森跑向码头。" },
            { title: "第1集", text: "罗森落水。" },
            { title: "正文 第2集·获救", text: "船把罗森救了起来。" },
        ],
    );
    assert.equal(result.referenceText, "后续大纲\n第2集\n安排登塔。\n\n后续大纲：\n第3集\n计划寻找证人。\n\n后续大纲\n第3集\n准备返港。");
});

test("resumes the script after an outline at a titled 正文 heading", () => {
    const result = analyzeNovel("第1集\n罗森跑向码头。\n后续大纲\n第2集\n安排登塔。\n## 【正文：第一幕】\n罗森从船上跳下来。\n第2集\n他失去平衡。", { script: true });
    assert.equal(result.referenceText, "后续大纲\n第2集\n安排登塔。");
    assert.deepEqual(
        result.chapters.map(({ title, text }) => ({ title, text })),
        [
            { title: "第1集", text: "罗森跑向码头。" },
            { title: "【正文：第一幕】", text: "罗森从船上跳下来。" },
            { title: "第2集", text: "他失去平衡。" },
        ],
    );
});

test("accepts legacy script heading separators and keeps comma-led sentences in the body", () => {
    const result = analyzeNovel("第1集\n第2集，罗森想起船长说的话。\n第2集·风暴\n罗森落水。\n正文 第3集\n渔船把罗森救了起来。\n第四集，\n渔船随风漂离。", { script: true });
    assert.deepEqual(
        result.chapters.map(({ title, text }) => ({ title, text })),
        [
            { title: "第1集", text: "第2集，罗森想起船长说的话。" },
            { title: "第2集·风暴", text: "罗森落水。" },
            { title: "正文 第3集", text: "渔船把罗森救了起来。" },
            { title: "第四集，", text: "渔船随风漂离。" },
        ],
    );
});

test("keeps an outline mention in dialogue and does not reclassify per-episode novels", () => {
    const raw = "序章\n秦子文打开窗户。\n第一章\n秦子文：后续大纲我还没有写。\n第二章\n小区出现在荒野。";
    const script = analyzeNovel(raw, { script: true });
    assert.equal(script.chapters[0].title, "序章");
    assert.equal(script.chapters[1].text, "秦子文：后续大纲我还没有写。");

    const novel = analyzeNovel(raw, { perEpisode: true });
    assert.equal(novel.referenceText, undefined);
    assert.deepEqual(
        novel.chapters.map((chapter) => chapter.title),
        ["序章", "第一章", "第二章"],
    );
});

test("auto detects a script only from episode headings and explicitly marked reference", () => {
    assert.equal(analyzeNovel("《故事》\n第1集\n有人打开了窗户。", { perEpisode: true, script: "auto" }).referenceText, undefined);
    assert.equal(analyzeNovel("前言\n角色的故事。\n第一章\n有人打开了窗户。", { perEpisode: true, script: "auto" }).referenceText, undefined);
    assert.equal(analyzeNovel("第1集\n有人打开了窗户。\n后续大纲：\n第2集\n风雨将至。", { script: "auto" }).referenceText, "后续大纲：\n第2集\n风雨将至。");
    assert.equal(analyzeNovel("人物小传：窗边的女孩会画画。\n第1集\n有人打开了窗户。", { script: "auto" }).referenceText, "人物小传：窗边的女孩会画画。");
});

test("keeps labelled novel settings for extraction and adapts the prologue in both episode modes", () => {
    const reference = [
        "《潮汐灯塔》",
        "## 【世界观设定】",
        "灯塔每次升起时都能照到过去。",
        "**人物小传**：守塔人罗森从小养着一只褐色信鸽。",
        "场景设定",
        "悬崖边的灯塔里有一本潮汐簿。",
        "风格设置：潮湿，灰蓝色。",
        "视觉风格",
        "用光束和薄雾表现夜航。",
    ].join("\n");
    const opening = "风暴第一夜，罗森望见一艘消失已久的船。";
    const firstChapter = `${body("罗森拉响铜铃。")}\n人物小传：罗森读出了这一行字。\n信鸽掠过窗户。`;
    const raw = [reference, "楔子", opening, "第一章 灯塔", firstChapter].join("\n");

    const perChapter = analyzeNovel(raw, { novelReference: true, perEpisode: true });
    assert.equal(perChapter.referenceText, reference);
    assert.deepEqual(
        perChapter.chapters.map(({ title, text }) => ({ title, text })),
        [
            { title: "楔子", text: opening },
            { title: "第一章 灯塔", text: firstChapter },
        ],
    );
    const auto = analyzeNovel(raw, { novelReference: true, script: "auto" });
    assert.equal(auto.detectedScript, undefined);
    assert.equal(auto.referenceText, reference);
    assert.equal(auto.chapters[0].title, "楔子 · 第一章 灯塔");
    assert.equal(auto.chapters[0].text, `${opening}\n\n${firstChapter}`);
});

test("keeps unlabelled opening prose even when labelled settings follow it", () => {
    const opening = "海上没有月亮。\n灯塔只亮了一下。";
    const context = "创作设定：低饱和风格。";
    const text = "罗森听到门外有风。";
    const withSettings = analyzeNovel(`${opening}\n${context}\n第一章\n${text}`, { novelReference: true, perEpisode: true });
    assert.equal(withSettings.referenceText, context);
    assert.deepEqual(
        withSettings.chapters.map((chapter) => chapter.text),
        [opening, text],
    );

    const withoutSettings = analyzeNovel(`${opening}\n第一章\n${text}`, { novelReference: true, perEpisode: true });
    assert.equal(withoutSettings.referenceText, undefined);
    assert.deepEqual(
        withoutSettings.chapters.map((chapter) => chapter.text),
        [opening, text],
    );
});

test("keeps a reference-only document out of the episode directory, including empty numbered chapters", () => {
    const reference = "人物小传：守塔人罗森。\n场景设定：悬崖灯塔。";
    const synopsis = "剧本简介\n海边的灯塔会随潮水移动。\n前情提要\n罗森曾经守在塔里。";
    for (const [raw, expected] of [
        [reference, reference],
        [reference + "\n第一集", reference],
        [reference + "\n第一章\n第二章", reference],
        [reference + "\n正文：", reference],
        [synopsis, synopsis],
    ]) {
        for (const options of [{ novelReference: true }, { script: true }, { script: "auto", novelReference: true }] as const) {
            const result = analyzeNovel(raw, { ...options, perEpisode: true });
            assert.deepEqual(result.chapters, []);
            assert.equal(result.referenceText, expected);
            assert.ok(result.issues.some(({ kind }) => kind === "reference_only"));
        }
    }
});

test("keeps unnumbered scene directions following reference material in a single episode", () => {
    const reference = "剧本简介\n海边的灯塔会随潮水移动。";
    const scene = "1-1 灯塔 夜 内\n△林晚推开门。";
    for (const options of [{ script: true }, { script: "auto", novelReference: true }, { novelReference: true }] as const) {
        const result = analyzeNovel(reference + "\n" + scene, { ...options, perEpisode: true });
        assert.equal(result.referenceText, reference);
        assert.deepEqual(
            result.chapters.map(({ text }) => text),
            [scene],
        );
    }
});

test("returns the novel opening introduced by a titled body marker as narrative", () => {
    const ref = "人物小传\n林晚原是守塔人。";
    const first = "林晚推开了门。";
    const next = "她向海边走去。";
    const result = analyzeNovel([ref, "正文：风雪夜归人", first, "第一章", next].join("\n"), { novelReference: true, perEpisode: true });
    assert.equal(result.referenceText, ref);
    assert.deepEqual(
        result.chapters.map(({ title, text }) => [title, text]),
        [
            ["正文：风雪夜归人", first],
            ["第一章", next],
        ],
    );
});

test("keeps decorated numbered titles and standard unnumbered titles after the script begins", () => {
    const ref = "人物小传\n林晚原是守塔人。";
    const raw = [ref, "第一集", "她推开窗。", "--- 第二集 ---", "屋里响起电话。", "尾声", "她独自走进雪里。"].join("\n");
    for (const script of [true, "auto"] as const) {
        const result = analyzeNovel(raw, { script, perEpisode: true });
        assert.equal(result.referenceText, ref);
        assert.deepEqual(
            result.chapters.map(({ title, text }) => [title, text]),
            [
                ["第一集", "她推开窗。"],
                ["第二集", "屋里响起电话。"],
                ["尾声", "她独自走进雪里。"],
            ],
        );
    }
});

test("a narrative prologue with episode-numbered novel chapters does not signal a script", () => {
    const raw = "序章\n我在走廊里醒来。\n第一集\n他昨夜已经离开。\n第二集\n我翻开了那封信。";
    const result = analyzeNovel(raw, { script: "auto", novelReference: true, perEpisode: true });
    assert.equal(result.detectedScript, undefined);
    assert.equal(result.referenceText, undefined);
    assert.deepEqual(
        result.chapters.map(({ title }) => title),
        ["序章", "第一集", "第二集"],
    );
});

test("a standalone 正文 marker also starts an unnumbered novel", () => {
    const reference = "场景设置：潮水退去后出现一座灯塔。\n视觉风格设置：雾蓝色。";
    const narrative = "罗森把铜铃带上渔船。";
    const result = analyzeNovel(`${reference}\n正文：\n${narrative}`, { novelReference: true });
    assert.equal(result.referenceText, reference);
    assert.deepEqual(
        result.chapters.map((chapter) => chapter.text),
        [narrative],
    );
});

test("an opening prologue marker wraps reference only when it immediately introduces settings", () => {
    const wrapped = "序章\n\n场景设置\n灯塔中的密室。";
    const chapter = "第一章\n罗森登塔。";
    for (const reference of [wrapped, `《潮汐灯塔》\n\n${wrapped}`]) {
        const result = analyzeNovel(`${reference}\n${chapter}`, { novelReference: true, perEpisode: true });
        assert.equal(result.referenceText, reference);
        assert.deepEqual(
            result.chapters.map((episode) => episode.title),
            ["第一章"],
        );
    }

    const genuine = "序章\n罗森在海边醒来。\n场景设置\n那是信上写的四个字。";
    const fallback = analyzeNovel(`${genuine}\n${chapter}`, { novelReference: true, perEpisode: true });
    assert.equal(fallback.referenceText, undefined);
    assert.equal(fallback.chapters[0].title, "序章");
    assert.equal(fallback.chapters[0].text, "罗森在海边醒来。\n场景设置\n那是信上写的四个字。");
});

test("a positively identified script takes precedence over novel settings", () => {
    const result = analyzeNovel("世界观设定\n这座城市忽然停电。\n人物小传：守塔人罗森。\n第1集\n罗森跑进灯塔。", { novelReference: true, script: "auto" });
    assert.equal(result.detectedScript, true);
    assert.equal(result.referenceText, "世界观设定\n这座城市忽然停电。\n人物小传：守塔人罗森。");
    assert.equal(result.chapters[0].title, "第1集");
});

test("round-trips Markdown with original novel format, reference text and exact chapter boundaries", () => {
    const referenceText = "人物小传\n~~~\n罗森的背包里有旧地图。\n# 正文\n~~~~\n\n";
    const chapters = [
        { title: "第一集", text: "\n　开船。\n\n---\n\n# 第四幕\n\n<!-- yingce-drama-chapter:0 -->\n\n罗森打开背包。\n" },
        { title: "来客 & &#10;\n夜渡", text: "船上传来呼救。\n\n本章完\n  " },
    ];
    const exported = formatDramaSourceMarkdown({ sourceFormat: "novel", referenceText, chapters });
    const result = analyzeNovel(`\uFEFF${exported.replaceAll("\n", "\r\n")}\r\n`, { novelReference: true, script: "auto" });
    assert.equal(result.sourceFormat, "novel");
    assert.equal(result.detectedScript, undefined);
    assert.equal(result.referenceText, referenceText);
    assert.deepEqual(
        result.chapters.map(({ title, text }) => ({ title, text })),
        chapters,
    );
    assert.equal(result.removedNoiseLines, 0);
});

test("round-trips custom storyboard titles without reference text and rejects damaged exports", () => {
    const chapters = [
        { title: "夜渡", text: "海面一片漆黑。" },
        { title: "来客", text: "灯塔亮了。" },
    ];
    const exported = formatDramaSourceMarkdown({ sourceFormat: "storyboard", referenceText: "", chapters });
    const result = analyzeNovel(exported, { perEpisode: true, script: "auto" });
    assert.equal(result.sourceFormat, "storyboard");
    assert.equal(result.referenceText, "");
    const episode = formatDramaSourceMarkdown({ sourceFormat: "storyboard", chapters });
    assert.equal(analyzeNovel(episode, { perEpisode: true }).referenceText, undefined);
    assert.deepEqual(
        result.chapters.map(({ title, text }) => ({ title, text })),
        chapters,
    );
    const broken = analyzeNovel(exported.slice(0, exported.lastIndexOf("<!--")), { perEpisode: true });
    assert.deepEqual(broken.chapters, []);
    assert.equal(broken.issues[0]?.kind, "invalid_export");
});

test("an old Markdown reference block does not identify a novel with episode headings as a script", () => {
    const result = analyzeNovel("# 作品参考资料\n\n~~~\n世界观设定\n灯塔映出旧日的倒影。\n~~~\n\n# 正文\n\n# 第一集\n\n罗森登塔。\n\n---\n\n# 第二集\n\n罗森发现信鸽。", {
        perEpisode: true,
        novelReference: true,
        script: "auto",
    });
    assert.equal(result.detectedScript, undefined);
    assert.equal(result.referenceText, "世界观设定\n灯塔映出旧日的倒影。");
    assert.deepEqual(
        result.chapters.map(({ title }) => title),
        ["第一集", "第二集"],
    );
});

test("derives a clean title from the file name", () => {
    assert.equal(titleFromFileName("斗破苍穹（全本）.txt"), "斗破苍穹");
    assert.equal(titleFromFileName("my_novel.md"), "my_novel");
});
