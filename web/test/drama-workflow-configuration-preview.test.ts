import { expect, test } from "bun:test";
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
