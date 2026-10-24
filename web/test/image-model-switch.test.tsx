import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSizePicker } from "../src/components/image-size-picker";
import { buildNodeConfig, canvasModelConfigPatch } from "../src/components/canvas/canvas-node-prompt-config";
import { applyNodeConfigPatch } from "../src/lib/canvas/canvas-project-domain";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-project-generation";
import { defaultImageCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { IMAGE_RATIOS, IMAGE_RESOLUTIONS, imagePresetForRatio, imageSizeConfigWithPresets } from "../src/lib/image-size-presets";
import { modelGenerationParamsForSwitch } from "../src/lib/model-selection";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const gemini = "wangsu::gemini-3-pro-image";
const liblib = "liblib::0ea388c7eb854be3ba3c6f65aac6bfd3";
const wangsuGpt = "wangsu::gpt-image-2";

function imageSwitchConfig(): AiConfig {
    const liblibImage = defaultImageCapabilityConfig("liblib-image", liblib.split("::")[1]);
    // Match Dream Tech XL's current pixel contract: custom sizes and three preset tiers.
    const presets = IMAGE_RESOLUTIONS.flatMap((tier) => IMAGE_RATIOS.map((ratio) => imagePresetForRatio(tier, ratio)));
    const portrait = presets.find((preset) => preset.tier === "1k" && preset.ratio === "3:4")!;
    Object.assign(portrait, { width: 768, height: 1024, size: "768x1024" });
    liblibImage.size = imageSizeConfigWithPresets(liblibImage, presets);
    liblibImage.size.default = "768x1024";
    liblibImage.maxOutputs = 1;
    const models = [gemini, liblib, wangsuGpt];
    return {
        ...defaultConfig,
        models, imageModels: models, model: gemini, imageModel: gemini,
        size: "21:9", quality: "auto", imageResolution: "4k", count: "1", canvasImageCount: "1",
        channels: [
            { id: "wangsu", name: "Wangsu", scope: "system", enabled: true, baseUrl: "/api", apiKey: "", apiFormat: "openai", models: ["gemini-3-pro-image", "gpt-image-2"], modelCosts: [
                { model: "gemini-3-pro-image", capability: "image", protocol: "wangsu-gemini-image", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image: defaultImageCapabilityConfig("wangsu-gemini-image", "gemini-3-pro-image") } },
                { model: "gpt-image-2", capability: "image", protocol: "wangsu-images", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image: defaultImageCapabilityConfig("wangsu-images", "gpt-image-2") } },
            ] },
            { id: "liblib", name: "Liblib", scope: "system", enabled: true, baseUrl: "/api", apiKey: "", apiFormat: "openai", models: [liblib.split("::")[1]!], modelCosts: [
                { model: liblib.split("::")[1]!, capability: "image", protocol: "liblib-image", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: { version: 1, image: liblibImage } },
            ] },
        ],
    } as AiConfig;
}

function switchImage(target: string, size = "21:9", source = gemini) {
    const config = imageSwitchConfig();
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { model: source, size, quality: "auto", imageResolution: "4k", count: 1 } };
    const current = buildNodeConfig(config, node, "image", { capability: "image" });
    const switched = applyNodeConfigPatch(node, canvasModelConfigPatch(current, target, "image"));
    const generation = buildGenerationConfig(config, switched, "image");
    const profile = modelCapabilityConfigFor(generation, target).image!;
    const picker = renderToStaticMarkup(<ImageSizePicker profile={profile} size={generation.size} quality={generation.quality} imageResolution={generation.imageResolution} onChange={() => {}} />);
    return { switched, generation, request: backendProviderConfig(generation, "image"), output: picker.match(/<output\b[^>]*>(.*?)<\/output>/)?.[1] };
}

test.each([liblib, wangsuGpt])("Gemini 4K / 21:9 switches to explicit pixels shown and submitted by %s", (target) => {
    const { switched, generation, request, output } = switchImage(target);
    expect(switched.metadata?.size).toBe("2384x1024");
    expect(generation.size).toBe("2384x1024");
    expect(generation.imageResolution).toBe("auto");
    expect(request.size).toBe(generation.size);
    expect(output).toContain(`${request.size.replace("x", " × ")} px`);
});

test.each([
    { target: liblib, source: wangsuGpt, size: "2048x878" },
    { target: liblib, source: wangsuGpt, size: "3136x1344" },
    { target: liblib, source: wangsuGpt, size: "2384x1024" },
    { target: wangsuGpt, source: liblib, size: "1536x1024" },
    { target: wangsuGpt, source: liblib, size: "2384x1024" },
])("image switch preserves valid explicit pixels: %o", ({ target, source, size }) => {
    const { switched, request, output } = switchImage(target, size, source);
    expect(switched.metadata?.size).toBe(size);
    expect(request.size).toBe(size);
    expect(output).toContain(`${size.replace("x", " × ")} px`);
});

test("native Gemini keeps its independent ratio and 4K resolution when selected", () => {
    const config = imageSwitchConfig();
    expect(modelGenerationParamsForSwitch(config, gemini, "image")).toMatchObject({ size: "21:9", imageResolution: "4k" });
});

test.each([liblib, wangsuGpt])("an old ratio beyond pixel limits falls back to %s's configured default", (target) => {
    const config = imageSwitchConfig();
    const profile = modelCapabilityConfigFor(config, target).image!;
    expect(modelGenerationParamsForSwitch({ ...config, size: "8:1" }, target, "image").size).toBe(profile.size.default);
});
