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
    expect(workflowConfigurationSamples(resolveWorkflowConfigurationStyle(preset.prompt))).toEqual([{ url: preset.cover!, label: preset.name, illustrative: false }]);
});

test("补图预设用首张作为封面，按顺序展示三张专属样图", () => {
    expect(findDramaStyle("live-campus")?.sampleImages).toHaveLength(3);
    for (const style of DRAMA_STYLES) {
        if (!style.sampleImages) continue;
        expect(new Set(style.sampleImages).size, style.name).toBe(3);
        expect(style.cover, style.name).toBe(style.sampleImages[0]);
        expect(workflowConfigurationSamples(resolveWorkflowConfigurationStyle(style.prompt)), style.name).toEqual(style.sampleImages.map((url) => ({ url, label: style.name, illustrative: false })));
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
