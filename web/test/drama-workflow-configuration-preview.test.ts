import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { composeDramaStyleId, DRAMA_STYLES, findDramaStyle, getDramaStyleComposition } from "../src/lib/drama/drama-styles";
import { resolveWorkflowConfigurationStyle, workflowConfigurationSamples } from "../src/pages/projects/workflow-configuration-preview";

test("已保存的自由组合按完整提示词识别，参考图只来自同表现形式与题材", () => {
    for (const form of ["realistic", "2d", "3d"] as const) {
        const selected = findDramaStyle(composeDramaStyleId(form, "urban"))!;
        const resolved = resolveWorkflowConfigurationStyle(selected.prompt);
        expect(resolved?.id).toBe(selected.id);
        const samples = workflowConfigurationSamples(resolved);
        expect(samples.length).toBeGreaterThan(0);
        for (const sample of samples) {
            expect(sample.illustrative).toBe(true);
            expect(sample.url).toStartWith("/short-drama-styles/");
            expect(getDramaStyleComposition(DRAMA_STYLES.find((candidate) => candidate.name === sample.label)!.id)).toEqual({ formId: form, themeId: "urban" });
        }
        expect(selected.cover).toBeUndefined();
    }
});

test("手动改写或未知风格不误用组合参考图，原预设保留专属样图", () => {
    const composed = findDramaStyle(composeDramaStyleId("realistic", "urban"))!;
    expect(resolveWorkflowConfigurationStyle(`${composed.prompt}，手绘水墨表现`)).toBeUndefined();
    expect(workflowConfigurationSamples(resolveWorkflowConfigurationStyle("自定义画风"))).toEqual([]);
    const preset = findDramaStyle("live-sweet")!;
    expect(workflowConfigurationSamples(resolveWorkflowConfigurationStyle(preset.prompt))[0]).toEqual({ url: "/short-drama-styles/sweet-romance.jpg", label: preset.name, illustrative: false });
});

test("仅存旧提示词的作品可还原预设预览，自定义改写继续使用项目自己的说明", () => {
    const previous = "三渲二卡通渲染，描边与色阶阴影，兼具 3D 运镜与日系动画观感。题材场景：城市街道、校园、奇幻场景。色彩光影：明快配色，硬色阶阴影与边缘光。服化道：日系动画风格服装。禁止：真人照片质感、二次元平涂、低模与穿模、文字水印";
    const preset = resolveWorkflowConfigurationStyle(previous);
    expect(preset?.id).toBe("3d-toon");
    expect(preset?.prompt).not.toBe(previous);
    expect(resolveWorkflowConfigurationStyle(previous, { mode: "custom" })).toBeUndefined();
    expect(resolveWorkflowConfigurationStyle(previous.replace("硬色阶", "柔和渐变"))).toBeUndefined();
    expect(resolveWorkflowConfigurationStyle(previous, { mode: "preset", presetId: "3d-toon" })).toBe(preset);
});

test("补图预设用首张作为封面，按顺序展示全部专属样图", () => {
    expect(findDramaStyle("live-campus")?.sampleImages).toHaveLength(5);
    expect(findDramaStyle("3d-guoman")?.sampleImages).toHaveLength(11);
    for (const style of DRAMA_STYLES) {
        const sampleImages = style.sampleImages ?? [];
        expect(sampleImages.length, style.name).toBeGreaterThanOrEqual(5);
        expect(new Set(sampleImages).size, style.name).toBe(sampleImages.length);
        expect(style.cover, style.name).toBe(sampleImages[0]);
        expect(workflowConfigurationSamples(resolveWorkflowConfigurationStyle(style.prompt)), style.name).toEqual(sampleImages.map((url) => ({ url, label: style.name, illustrative: false })));
    }
});

test("每个预设的封面与样图都能在静态资源目录找到", () => {
    for (const style of DRAMA_STYLES) {
        expect(style.cover, style.name).toBeDefined();
        for (const { url } of workflowConfigurationSamples(style)) {
            expect(existsSync(new URL(`../public${url}`, import.meta.url)), `${style.name} ${url}`).toBe(true);
        }
    }
});
