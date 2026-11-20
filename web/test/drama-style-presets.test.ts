import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { canvasStylePresets } from "@/components/canvas/canvas-style-picker-modal";
import { DRAMA_STYLES, dramaReferenceStyles, dramaStylePresetsForType, dramaStyleTagsForType, filterDramaStylePresets, findDramaStyle } from "@/lib/drama/drama-styles";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "@/lib/drama/style-limits";

test("预设先交代媒介和光色，三渲二允许硬边色阶", () => {
    for (const { name, prompt, detail } of DRAMA_STYLES) {
        expect(prompt, name).toStartWith(`${detail.medium}。色彩光影：${detail.look}`);
    }
    expect(findDramaStyle("2d-manhua")?.detail.medium).toContain("国漫");
    expect(findDramaStyle("3d-toon")?.detail.medium).toContain("赛璐珞");
    expect(findDramaStyle("3d-toon")?.detail.forbid).not.toContain("二次元平涂");
});

test("完整系统风格及负面说明均能保存到作品默认与单集独立风格", () => {
    const prompts = [...DRAMA_STYLES.map((style) => style.prompt), ...canvasStylePresets.map((style) => [style.prompt, style.profile?.negativePrompt ? `禁止：${style.profile.negativePrompt}` : ""].filter(Boolean).join("\n"))];
    expect(prompts.some((prompt) => Array.from(prompt).length > 1200)).toBe(true);
    for (const prompt of prompts) expect(Array.from(prompt).length).toBeLessThanOrEqual(DRAMA_STYLE_PROMPT_MAX_LENGTH);
});

test("剧集类型先确定预设范围，题材标签按固定顺序且覆盖目录", () => {
    const labels = ["全部", "通用", "科幻奇幻", "悬疑诡异", "古代言情", "玄幻仙侠", "国风武侠", "年代历史", "现代言情"];
    for (const type of ["comic", "live_action"]) {
        const tags = dramaStyleTagsForType(type);
        const presets = dramaStylePresetsForType(type);
        expect(tags.map(({ label }) => label)).toEqual(labels);
        expect(filterDramaStylePresets(type, "all")).toEqual(presets);
        const categorized = new Set(tags.filter(({ key }) => key !== "all").flatMap(({ key }) => filterDramaStylePresets(type, key).map(({ id }) => id)));
        expect(categorized).toEqual(new Set(presets.map(({ id }) => id)));
        for (const { key, label } of tags) {
            if (key === "all") continue;
            const matches = filterDramaStylePresets(type, key);
            expect(filterDramaStylePresets(type, key, label)).toEqual(matches);
            for (const style of matches) expect(style.tags, style.name).toContain(label);
        }
    }
    expect(filterDramaStylePresets("narration", "xianxia")).toEqual(filterDramaStylePresets("comic", "xianxia"));
});

test("题材和关键词同时筛选，同一预设可匹配多个题材", () => {
    expect(filterDramaStylePresets("comic", "xianxia", " 国漫 ").map(({ id }) => id)).toEqual(["3d-guoman"]);
    expect(filterDramaStylePresets("comic", "modern-romance", "国漫")).toEqual([]);
    expect(filterDramaStylePresets("live_action", "xianxia", "国漫")).toEqual([]);
    for (const tag of ["suspense", "historical"] as const) {
        expect(filterDramaStylePresets("live_action", tag, "旗袍").map(({ id }) => id)).toEqual(["live-republic"]);
    }
});

test("参考图库覆盖全部本地样图，相近预设共用稳定 ID", () => {
    const referenceImages = dramaReferenceStyles.flatMap(({ sampleImages = [] }) => sampleImages.filter((url) => url.startsWith("/short-drama-styles/references/")));
    expect(referenceImages).toHaveLength(290);
    expect(new Set(referenceImages).size).toBe(290);
    for (const path of referenceImages) expect(existsSync(new URL(`../public${path}`, import.meta.url)), path).toBe(true);
    const comicIds = new Set(dramaStylePresetsForType("comic").map(({ id }) => id));
    const liveIds = new Set(dramaStylePresetsForType("live_action").map(({ id }) => id));
    for (const { id, category } of dramaReferenceStyles) {
        expect(comicIds.has(id), id).toBe(category !== "live");
        expect(liveIds.has(id), id).toBe(category === "live");
    }
    expect(filterDramaStylePresets("comic", "all", "国漫3D新风格").map(({ id }) => id)).toEqual(["3d-guoman"]);
    expect(filterDramaStylePresets("comic", "all", "青春校园").map(({ id }) => id)).toContain("2d-cinematic-anime");
    expect(findDramaStyle("3d-guoman")?.sampleImages).toContain("/short-drama-styles/references/102/cover.jpg");
});

test("真人多图完整保留，重复封面去重，3D 参考图归入漫剧", () => {
    const sizes = {
        "live-neutral": 8,
        "live-urban": 7,
        "live-western-urban": 9,
        "live-nature": 6,
        "live-korean-soft": 14,
    };
    for (const [id, count] of Object.entries(sizes)) expect(findDramaStyle(id)?.sampleImages, id).toHaveLength(count);
    expect(findDramaStyle("live-western-urban")?.sampleImages).not.toContain("/short-drama-styles/references/34/6.jpg");
    expect(findDramaStyle("3d-cyber-game")?.sampleImages).toEqual([
        "/short-drama-styles/references/129/cover.jpg",
        "/short-drama-styles/references/130/2.jpg",
        "/short-drama-styles/references/130/3.jpg",
        "/short-drama-styles/generated/3d-cyber-game-1.jpg",
        "/short-drama-styles/generated/3d-cyber-game-2.jpg",
    ]);
    for (const id of ["3d-cyber-game", "3d-soda-characters", "3d-ethereal-gufeng"]) {
        expect(dramaStylePresetsForType("comic").some((style) => style.id === id)).toBe(true);
        expect(dramaStylePresetsForType("live_action").some((style) => style.id === id)).toBe(false);
    }
});
