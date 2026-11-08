import { expect, test } from "bun:test";

import { buildStyleProfileDraftPrompt, parseStyleProfileDraft, STYLE_DRAFT_IDEA_LIMIT } from "@/lib/canvas/style-profile-drafting";
import { createStyleProfileSnapshot } from "@/lib/canvas/style-profile";

function current() {
    return createStyleProfileSnapshot({
        presetId: "my-style",
        sourceProfileId: "profile-id",
        title: "原风格",
        description: "原简介",
        tags: ["原标签"],
        prompt: "原提示词",
        source: "user",
        revision: 3,
        coverUrl: "/api/resources/my-private-cover/file",
        assets: [{ id: "existing-prompt", kind: "prompt", provider: "user", title: "原文字模块", promptFragment: "保留细腻材质", status: "validated", enabled: true }],
    });
}

function output(patch: Record<string, unknown> = {}) {
    return {
        title: "东方志怪 · 工笔暗彩",
        description: "以克制暗彩和工笔线条呈现东方志怪世界。",
        tags: ["东方志怪", "工笔", "暗彩"],
        prompt: "使用工笔线条和克制暗彩，统一人物服饰、建筑材质与自然光影。保持跨镜头色彩和角色造型一致。",
        negativePrompt: "避免现代物件、荧光色、文字水印和媒介漂移。",
        selection: { world: "东方志怪", medium: "工笔动画", tone: "克制神秘", character: "东方古典造型" },
        executionPolicy: "compatible-fallback",
        ...patch,
    };
}

test("完整配置与 JSON 围栏均可解析并保留宿主元数据", () => {
    const source = current();
    const before = structuredClone(source);
    for (const text of [JSON.stringify(output()), `\n\`\`\`json\n${JSON.stringify(output())}\n\`\`\`\n`]) {
        const result = parseStyleProfileDraft(text, source);
        expect(result).toMatchObject({ ...output(), presetId: source.presetId, sourceProfileId: source.sourceProfileId, source: "user", revision: 3, coverUrl: source.coverUrl, assets: source.assets });
        expect(result).not.toBe(source);
    }
    expect(source).toEqual(before);
});

test("模型伪造身份、封面和执行资产不覆盖真实草稿", () => {
    const source = current();
    const result = parseStyleProfileDraft(
        JSON.stringify(output({ presetId: "stolen", sourceProfileId: "other", source: "builtin", revision: 999, schemaVersion: 2, coverUrl: "https://evil.example/fake.png", assets: [{ kind: "lora", sourceId: "fake-model" }] })),
        source,
    );
    expect(result.presetId).toBe("my-style");
    expect(result.sourceProfileId).toBe("profile-id");
    expect(result.source).toBe("user");
    expect(result.revision).toBe(3);
    expect(result.schemaVersion).toBe(1);
    expect(result.coverUrl).toBe(source.coverUrl);
    expect(result.assets).toEqual(source.assets);
});

test.each(["", '{"title":"截断', `说明：${JSON.stringify(output())}`, `${JSON.stringify(output())}\n${JSON.stringify(output())}`, "[]", "null", JSON.stringify({ title: "只有名称" })])("错误格式不能部分应用：用例 %#", (text) => {
    const source = current();
    const before = structuredClone(source);
    expect(() => parseStyleProfileDraft(text, source)).toThrow();
    expect(source).toEqual(before);
});

test.each([
    { title: " " },
    { title: "字".repeat(81) },
    { description: 12 },
    { description: "字".repeat(501) },
    { prompt: "" },
    { negativePrompt: null },
    { negativePrompt: "字".repeat(64 * 1024 + 1) },
    { tags: ["可用", 4] },
    { tags: [" "] },
    { tags: Array.from({ length: 21 }, () => "标签") },
    { selection: { world: "世界", medium: "媒介", tone: "气质", character: "造型", assetId: "fake" } },
    { selection: { world: "世界", medium: "媒介", tone: "气质" } },
    { selection: { world: "世界", medium: "媒介", tone: "气质", character: "字".repeat(201) } },
    { selection: { world: "世界", medium: "媒介", tone: "气质", character: 4 } },
    { executionPolicy: "auto-generate" },
])("字段类型、长度和枚举不合法时整份拒绝：用例 %#", (patch) => {
    expect(() => parseStyleProfileDraft(JSON.stringify(output(patch)), current())).toThrow();
});

test("请求只包含风格文字，不把封面 URL 或执行资产交给模型", () => {
    const source = current();
    source.assets[0].sourceUrl = "https://private.example/existing-asset";
    const prompt = buildStyleProfileDraftPrompt("  细腻的东方工笔风格  ", source);
    expect(prompt).toContain("细腻的东方工笔风格");
    expect(prompt).toContain('"world"');
    expect(prompt).toContain("原提示词");
    expect(prompt).not.toContain(source.coverUrl!);
    expect(prompt).not.toContain("https://private.example/existing-asset");
    expect(prompt).not.toContain("profile-id");
    expect(prompt).toContain("Prompt 通用");
    expect(() => buildStyleProfileDraftPrompt(" ", source)).toThrow();
    expect(() => buildStyleProfileDraftPrompt("字".repeat(STYLE_DRAFT_IDEA_LIMIT + 1), source)).toThrow();
    expect(() => buildStyleProfileDraftPrompt("字".repeat(STYLE_DRAFT_IDEA_LIMIT), source)).not.toThrow();
});
