import { expect, test } from "bun:test";

import { canvasStylePresets, resolveCanvasStylePreset, resolveProjectCanvasStyle } from "@/components/canvas/canvas-style-picker-modal";
import { recommendedCanvasStylePresets } from "@/lib/canvas/canvas-style-system";
import { createStyleProfileSnapshot, serializeStyleProfile } from "@/lib/canvas/style-profile";
import { dramaReferenceStyles } from "@/lib/drama/drama-styles";

test("画布系统风格复用短剧样图，已有同类画风只显示一次", () => {
    expect(dramaReferenceStyles.length).toBeGreaterThan(0);
    expect(new Set(canvasStylePresets.map(({ id }) => id)).size).toBe(canvasStylePresets.length);
    for (const style of dramaReferenceStyles) {
        const preset = resolveCanvasStylePreset(style.id);
        expect(preset?.sampleImages).toEqual(style.sampleImages);
        expect(preset?.imageUrl).toBe(style.cover);
        expect(preset?.prompt).toBe(style.prompt);
        expect(preset?.profile?.prompt).toBe(style.prompt);
        expect(preset?.tags.slice(0, style.tags.length)).toEqual(style.tags);
        expect(preset?.profile?.tags).toEqual(preset?.tags);
        expect(canvasStylePresets.filter((item) => item.prompt === preset?.prompt)).toHaveLength(1);
        expect((preset?.profile?.assets || []).flatMap(({ referenceUrls }) => referenceUrls || [])).toEqual([]);
    }
});

test("真人风格合并到对应的画布预设，同时保留独立的摄影风格", () => {
    const legacyIDs = [
        ["live-urban", "urban-live-action"],
        ["live-period-aesthetic", "period-live-action"],
        ["live-hk", "retro-hong-kong"],
        ["live-nature", "nature-healing"],
    ];
    for (const [id, legacyID] of legacyIDs) {
        const source = dramaReferenceStyles.find((style) => style.id === id);
        const preset = resolveCanvasStylePreset(id);
        expect(source).toBeDefined();
        expect(preset?.id).toBe(legacyID);
        expect(preset?.prompt).toBe(source?.prompt);
        expect(canvasStylePresets.filter((item) => item.prompt === source?.prompt).map((item) => item.id)).toEqual([legacyID]);
    }
    expect(resolveCanvasStylePreset("live-neutral")?.id).toBe("live-neutral");
    expect(resolveCanvasStylePreset("live-western-fantasy")?.id).toBe("live-western-fantasy");
});

test("合并样图后仍可读取旧画布风格和项目已保存的快照", () => {
    const legacy = resolveCanvasStylePreset("fantasy-3d")!;
    const recommended = recommendedCanvasStylePresets.find(({ id }) => id === "v2-xianxia--epic--3d-anime--semi-real")!;
    const current = resolveCanvasStylePreset(recommended.id)!;
    const reference = dramaReferenceStyles.find(({ id }) => id === "3d-guoman")!;
    expect(legacy.id).toBe("fantasy-3d");
    expect(current.id).toBe(recommended.id);
    expect(legacy.prompt).toBe(reference.prompt);
    expect(current.prompt).toBe(reference.prompt);
    expect(current.profile?.selection).toEqual(recommended.profile?.selection);
    expect(legacy.sampleImages).toEqual(current.sampleImages);
    expect(current.sampleImages?.length).toBeGreaterThan(0);

    const snapshot = createStyleProfileSnapshot({
        ...legacy.profile!,
        prompt: recommended.prompt,
        assets: [{ id: "saved-prompt", kind: "prompt", provider: "builtin", title: "项目提示词", promptFragment: "保留角色服装配色", status: "validated" }],
    });
    const restored = resolveProjectCanvasStyle(legacy.id, serializeStyleProfile(snapshot));
    expect(restored?.id).toBe("fantasy-3d");
    expect(restored?.prompt).toBe(snapshot.prompt);
    expect(restored?.profile?.assets).toEqual(snapshot.assets);
    expect(restored?.sampleImages).toEqual(current.sampleImages);
});
