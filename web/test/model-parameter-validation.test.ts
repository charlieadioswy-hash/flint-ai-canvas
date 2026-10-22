import { expect, test } from "bun:test";
import { imageParameterRequest, normalizeImageParameters, projectImageParameters } from "../src/lib/image-parameters";
import { defaultModelCapabilityConfig, normalizeImageValue, normalizeVideoValue, videoDurationAllowed } from "../src/lib/model-capabilities";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-project-generation";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { canvasModelConfigPatch } from "../src/components/canvas/canvas-node-prompt-config";
import { applyNodeConfigPatch } from "../src/lib/canvas/canvas-project-domain";
import { modelGenerationParameterError, modelGenerationParamsForSwitch } from "../src/lib/model-selection";
import { modelQuoteRequest } from "../src/lib/model-pricing";

function configForImage(): AiConfig {
    const capabilityConfig = defaultModelCapabilityConfig();
    capabilityConfig.image = { ...capabilityConfig.image!, size: { parameter: "size", values: ["512x512", "1024x1024"], default: "512x512", allowCustom: false }, resolution: { supported: true, values: ["1k", "2k"], default: "1k" }, maxOutputs: 2 };
    return { ...defaultConfig, models: ["test::image"], imageModels: ["test::image"], model: "test::image", imageModel: "test::image", size: "512x512", imageResolution: "1k", count: "1", canvasImageCount: "1", channels: [{ id: "test", name: "Test", scope: "system", enabled: true, baseUrl: "/api", apiKey: "", apiFormat: "openai", models: ["image"], modelCosts: [{ model: "image", capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig }] }] } as AiConfig;
}

test("schema count enums drive the visible maximum and invalid defaults fall back to an allowed value", () => {
    const fields = [{ name: "count", label: "数量", type: "integer" as const, values: [1, 4, 8], default: 3 }];
    const profile = projectImageParameters(defaultModelCapabilityConfig().image!, fields);
    expect(profile.maxOutputs).toBe(8);
    expect(normalizeImageValue(profile, { count: "9" }).count).toBe("1");
    expect(imageParameterRequest(profile, { count: "4" }, true)?.count).toBe(4);
    expect(normalizeImageParameters([{ name: "seed", label: "种子", type: "integer", default: 42 }, { name: "flag", label: "开关", type: "boolean", default: true }], { seed: 0, flag: false })).toEqual({ seed: 0, flag: false });
});

test("custom image sizes reject malformed old values during normalization", () => {
    const profile = { ...defaultModelCapabilityConfig().image!, size: { parameter: "size" as const, values: ["1024x1024"], default: "1024x1024", allowCustom: true } };
    expect(normalizeImageValue(profile, { size: "0x1024" }).size).toBe("1024x1024");
    expect(normalizeImageValue(profile, { size: "garbage" }).size).toBe("1024x1024");
    expect(normalizeImageValue(profile, { size: "1536x1024" }).size).toBe("1536x1024");
});

test("video ranges preserve declared zero and fractional steps", () => {
    const profile = { ...defaultModelCapabilityConfig().video!, duration: { selection: "range" as const, min: 0, max: 2, step: 0.5, default: 1.5 } };
    expect(normalizeVideoValue(profile, { seconds: "0" }).seconds).toBe("0");
    expect(normalizeVideoValue(profile, { seconds: "0.5" }).seconds).toBe("0.5");
    expect(normalizeVideoValue(profile, {}).seconds).toBe("1.5");
    expect(videoDurationAllowed(profile, 0)).toBe(true);
});

test.each([{ size: "4000x3000" }, { count: "3" }, { imageResolution: "4k" }])("task config rejects stale image parameters before sending: %o", (patch) => {
    const config = configForImage();
    expect(() => backendProviderConfig({ ...config, ...patch }, "image")).toThrow();
});

test("canvas submit does not silently clamp an old output count while showing a different quote", () => {
    const config = configForImage();
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { model: config.model, size: "512x512", count: 3 } };
    expect(() => buildGenerationConfig(config, node, "image")).toThrow(/数量|张数/);
});

test("canvas model switch preserves valid settings and sends the selected count to quote and task", () => {
    const config = configForImage();
    config.channels[0]!.modelCosts![0]!.logicalModelId = "image-logical";
    const current = { ...config, model: "previous::image", size: "1024x1024", imageResolution: "2k", count: "2", canvasImageCount: "1" };
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { model: current.model, count: 2 } };
    const switched = applyNodeConfigPatch(node, canvasModelConfigPatch(current, config.model, "image"));
    expect(switched.metadata?.count).toBe(2);
    expect(switched.metadata?.size).toBe("1024x1024");
    expect(switched.metadata?.imageResolution).toBe("2k");
    const generation = buildGenerationConfig(config, switched, "image");
    expect(generation.count).toBe("2");
    expect(modelQuoteRequest(generation, config.model, "image")?.intent.options.count).toBe(2);
    expect(backendProviderConfig(generation, "image").count).toBe("2");
});

test("switching to schema parameters corrects invalid fields and preserves typed zero and false", () => {
    const config = configForImage();
    config.channels[0]!.modelCosts![0]!.capabilityConfig!.image!.parameters = [
        { name: "size", label: "尺寸", type: "string", values: ["1:1", "16:9"], default: "1:1" },
        { name: "count", label: "数量", type: "integer", values: [1, 4, 8], default: 1 },
        { name: "seed", label: "种子", type: "integer", min: 0, default: 42 },
        { name: "flag", label: "开关", type: "boolean", default: true },
    ];
    const next = modelGenerationParamsForSwitch({ ...config, size: "16:9", count: "4", imageParameters: '{"seed":0,"flag":false,"removed":"old"}' }, config.model, "image");
    expect(next.size).toBe("16:9");
    expect(next.count).toBe("4");
    expect(JSON.parse(next.imageParameters!)).toMatchObject({ seed: 0, flag: false });
    expect(JSON.parse(next.imageParameters!)).not.toHaveProperty("removed");
    const corrected = modelGenerationParamsForSwitch({ ...config, size: "9:16", count: "3" }, config.model, "image");
    expect(corrected.size).toBe("1:1");
    expect(corrected.count).toBe("1");
    expect(modelGenerationParameterError(config, config.model, "image", { count: "3" })).toContain("数量");
});

test("video switch preserves valid fractional duration and resolution aliases, then rejects stale drafts", () => {
    const config = configForImage();
    const profile = config.channels[0]!.modelCosts![0]!.capabilityConfig!.video!;
    Object.assign(profile, { ratios: ["16:9"], defaultRatio: "16:9", resolutions: ["720p"], defaultResolution: "720p", duration: { selection: "range", min: 0, max: 2, step: 0.5, default: 1.5 } });
    const next = modelGenerationParamsForSwitch({ ...config, size: "16:9", videoSeconds: "0.5", vquality: "720", videoGenerateAudio: "false" }, config.model, "video");
    expect(next.videoSeconds).toBe("0.5");
    expect(next.vquality).toBe("720");
    expect(next.videoGenerateAudio).toBe("false");
    for (const patch of [{ videoSeconds: "3" }, { vquality: "1080p" }, { size: "9:16" }]) expect(modelGenerationParameterError(config, config.model, "video", patch)).not.toBe("");
    profile.ratios = [];
    profile.resolutions = [];
    expect(modelGenerationParameterError(config, config.model, "video", { size: "old", vquality: "old" })).toBe("");
});
