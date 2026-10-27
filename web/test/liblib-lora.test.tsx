import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiblibLoraFields } from "../src/components/liblib-lora-fields";
import { applyNodeConfigPatch } from "../src/lib/canvas/canvas-project-domain";
import { buildIrregularScreenTemplate } from "../src/lib/canvas/irregular-screen-domain";
import { screenControlParameters, screenDefaultSettings, screenProviderOptions, screenSettingsForModel, screenSettingsFromProvider } from "../src/lib/canvas/irregular-screen-model";
import { liblibLoraConfigurationError, parseLiblibLoras, type LiblibLoraProfile } from "../src/lib/canvas/liblib-lora";
import { createStyleProfileSnapshot, resolveStyleExecutionPlan } from "../src/lib/canvas/style-profile";
import { liblibLoraQuoteOptions } from "../src/lib/canvas/liblib-lora-quote";
import { modelQuoteRequest } from "../src/lib/model-pricing";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, type AiConfig } from "../src/stores/use-config-store";

const first = "11111111111111111111111111111111";
const second = "abcdefabcdefabcdefabcdefabcdefab";
const lora: LiblibLoraProfile = { supported: true, maxNetworks: 5, baseModel: "sdxl", models: [{ id: first, name: "屏幕风格", baseModel: "sdxl", triggerWords: ["screen style"], defaultWeight: 0.6 }, { id: second, name: "旧算法风格", baseModel: "sd15" }] };

function config(): AiConfig {
    const image = defaultImageCapabilityConfig("liblib-image");
    const channel = createModelChannel({ id: "liblib", name: "Liblib", scope: "system", baseUrl: "https://provider.example", apiKey: "system", interfaceType: "liblib-image", models: ["checkpoint"], modelCosts: [{ model: "checkpoint", capability: "image", protocol: "liblib-image", billingMode: "fixed_request", unitPriceMicrocredits: 1, defaultOptions: { family: "sd", steps: 20, textToImageTemplateUuid: "text-template" }, capabilityConfig: { version: 1, image: { ...image, lora: structuredClone(lora), controlNet: { supported: true, maxUnits: 1, baseModel: "sdxl", preprocessors: ["canny"], models: ["control"], modelCatalog: [{ id: "control", name: "Control", baseModel: "sdxl", controlTypes: ["canny"] }] } } } }] });
    return { ...defaultConfig, model: "liblib::checkpoint", imageModel: "liblib::checkpoint", channels: [channel], size: "1024x1024", count: "1" };
}

describe("Liblib LoRA configuration", () => {
    test("normalizes IDs and missing weights while retaining zero and negative weights", () => {
        expect(parseLiblibLoras([{ modelId: ` ${second.toUpperCase()} ` }, { modelId: first, weight: 0 }])).toEqual([{ modelId: second, weight: 0.8 }, { modelId: first, weight: 0 }]);
        expect(parseLiblibLoras([{ modelId: first, weight: -4 }])[0].weight).toBe(-4);
    });

    test.each([
        [{ modelId: first }, { modelId: first }],
        [{ modelId: first, weight: 4.01 }],
        [{ modelId: first, weight: "1" }],
        [{ modelId: first, triggerWords: ["untrusted"] }],
        [{ modelId: "invalid" }],
        Array.from({ length: 6 }, (_, index) => ({ modelId: String(index).repeat(32) })),
    ])("rejects invalid persisted selections: %j", (...items) => {
        expect(() => parseLiblibLoras(items)).toThrow();
    });

    test("rejects unavailable, incompatible and unsupported choices without changing them", () => {
        const selection = [{ modelId: second, weight: 1 }];
        expect(liblibLoraConfigurationError(selection, lora)).toContain("仅兼容 SD 1.5");
        expect(liblibLoraConfigurationError([{ modelId: "99999999999999999999999999999999" }], lora)).toContain("已登记目录");
        expect(liblibLoraConfigurationError(selection, lora, "openai-image")).toContain("不支持已选 LoRA");
        expect(selection).toEqual([{ modelId: second, weight: 1 }]);
        expect(liblibLoraConfigurationError([], undefined, "openai-image")).toBe("");
    });

    test("screen settings survive saved scene JSON and both screen and canvas model switches", () => {
        const current = config();
        const settings = { ...screenDefaultSettings(current, current.model), additionalNetwork: [{ modelId: first, weight: 0 }] };
        const source = { storageKey: "resource:screen", width: 1024, height: 1024 };
        const template = buildIrregularScreenTemplate({ generationMode: "text2img", prompt: "用户原始描述", modelSelection: { kind: "channel", channelId: "liblib", modelKey: "checkpoint" }, controlImage: source, outputMask: source, controlParameters: screenControlParameters(settings), size: "1024x1024", providerOptions: screenProviderOptions(current, current.model, settings, "text2img") });
        const restored = JSON.parse(JSON.stringify(template)) as typeof template;
        const node = restored.nodes.find((item) => item.id === restored.generationNodeId)!;
        const restoredSettings = screenSettingsFromProvider(screenDefaultSettings(current, current.model), node.metadata!.providerOptions!["liblib-image"]);
        expect(restoredSettings.additionalNetwork).toEqual(settings.additionalNetwork);
        expect(screenSettingsForModel(current, current.model, restoredSettings, "text2img").additionalNetwork).toEqual(settings.additionalNetwork);
        const switched = applyNodeConfigPatch(node, { model: "other::model" });
        expect(switched.metadata?.providerOptions).toEqual({ "liblib-image": { additionalNetwork: settings.additionalNetwork } });
        expect(switched.metadata?.generationSpec?.prompt).toBe("用户原始描述");
        expect(node.metadata?.providerOptions?.["liblib-image"].steps).toBe(20);
    });

    test("the actual task request retains registered LoRA choices and leaves the prompt unchanged", async () => {
        const current = config();
        current.channels[0].modelCosts![0].capabilityConfig!.image!.parameters = [];
        const task = await prepareBackendGenerationTask({ mode: "image", prompt: "用户原始描述", config: current, metadata: { providerOptions: { "liblib-image": { additionalNetwork: [{ modelId: ` ${first} `, weight: 0 }] } } } });
        expect(task.prompt).toBe("用户原始描述");
        expect(task.input?.prompt).toBe("用户原始描述");
        expect(task.input?.metadata).toMatchObject({ providerOptions: { "liblib-image": { additionalNetwork: [{ modelId: first, weight: 0 }] } } });
        expect(JSON.stringify(task.input?.metadata)).not.toContain("screen style");
    });

    test("submission rejects incompatible choices and an explicit clear overrides defaults", async () => {
        const current = config();
        current.channels[0].modelCosts![0].defaultOptions!.additionalNetwork = [{ modelId: first, weight: 0.6 }];
        await expect(prepareBackendGenerationTask({ mode: "image", prompt: "panda", config: current, metadata: { providerOptions: { "liblib-image": { additionalNetwork: [{ modelId: second }] } } } })).rejects.toThrow("仅兼容");
        const cleared = await prepareBackendGenerationTask({ mode: "image", prompt: "panda", config: current, metadata: { providerOptions: { "liblib-image": { additionalNetwork: [] } } } });
        expect(cleared.input?.metadata).toMatchObject({ providerOptions: { "liblib-image": { additionalNetwork: [] } } });
        current.channels[0].modelCosts![0].protocol = "openai-image";
        await expect(prepareBackendGenerationTask({ mode: "image", prompt: "panda", config: current, metadata: { providerOptions: { "liblib-image": { additionalNetwork: [{ modelId: first }] } } } })).rejects.toThrow("不支持已选 LoRA");
    });

    test("shared fields explain automatic trigger words and keep incompatible selections removable", () => {
        const markup = renderToStaticMarkup(<LiblibLoraFields value={[{ modelId: first, weight: 0 }]} profile={lora} onChange={() => {}} />);
        expect(markup).toContain("生成时自动加入触发词");
        expect(markup).toContain("screen style");
        expect(markup).toContain("清空 LoRA");
        const incompatible = renderToStaticMarkup(<LiblibLoraFields value={[{ modelId: second }]} profile={lora} onChange={() => {}} />);
        expect(incompatible).toContain("仅兼容 SD 1.5");
        expect(incompatible).toContain('aria-label="移除 LoRA 1"');
    });

    test("project style LoRA is native only when its version matches the trusted model catalog", () => {
        const style = createStyleProfileSnapshot({ presetId: "style", title: "风格", description: "", tags: [], prompt: "项目画风", executionPolicy: "strict-assets", assets: [{ id: "style-lora", title: "风格LoRA", kind: "lora", provider: "liblib", status: "validated", sourceId: "page-id", version: first, weight: -1, triggerWords: ["untrusted trigger"] }] });
        const plan = resolveStyleExecutionPlan(style, { mode: "image", model: "checkpoint", interfaceType: "liblib-image", loraProfile: lora });
        expect(plan.status).toBe("ready");
        expect(plan.assets[0].action).toBe("native");
        expect(plan.prompt).not.toContain("untrusted trigger");
        expect(resolveStyleExecutionPlan(style, { mode: "image", model: "checkpoint", interfaceType: "liblib-image" }).status).toBe("blocked");
        style.assets[0].version = second;
        expect(resolveStyleExecutionPlan(style, { mode: "image", model: "checkpoint", interfaceType: "liblib-image", loraProfile: lora }).status).toBe("blocked");
    });

    test("Liblib channel quotes retain an explicit clear and carry only LoRA choices", () => {
        const current = config();
        current.channels[0].modelCosts![0].defaultOptions!.additionalNetwork = [{ modelId: first, weight: 0.6 }];
        const defaults = liblibLoraQuoteOptions(current);
        expect(defaults).toEqual({ "liblib-image": { additionalNetwork: [{ modelId: first, weight: 0.6 }] } });
        const providerOptions = liblibLoraQuoteOptions(current, { "liblib-image": { additionalNetwork: [], family: "f1", templateUuid: "untrusted" } });
        const request = modelQuoteRequest(current, current.model, "image", { providerOptions: { ...providerOptions, other: { secret: "excluded" } } });
        expect(request).toMatchObject({ channelId: "liblib", modelKey: "checkpoint", intent: { providerOptions: { "liblib-image": { additionalNetwork: [] } } } });
        expect(JSON.stringify(request)).not.toContain("untrusted");
        expect(JSON.stringify(request)).not.toContain("excluded");
    });

    test("quotes combine project style LoRA with manual selections using the admission priority and limits", () => {
        const current = config();
        const profile = current.channels[0].modelCosts![0].capabilityConfig!.image!.lora!;
        profile.models[1].baseModel = "sdxl";
        const style = createStyleProfileSnapshot({ presetId: "style", title: "风格", description: "", tags: [], prompt: "", executionPolicy: "strict-assets", assets: [
            { id: "same", title: "重复风格", kind: "lora", provider: "liblib", status: "validated", version: first, weight: 1.2 },
            { id: "extra", title: "追加风格", kind: "lora", provider: "liblib", status: "validated", sourceId: second, weight: -0.5 },
        ] });
        const metadata = { "liblib-image": { additionalNetwork: [{ modelId: first, weight: 0 }] } };
        expect(liblibLoraQuoteOptions(current, metadata, style)).toEqual({ "liblib-image": { additionalNetwork: [{ modelId: first, weight: 0 }, { modelId: second, weight: -0.5 }] } });
        profile.maxNetworks = 1;
        expect(() => liblibLoraQuoteOptions(current, metadata, style)).toThrow("最多添加 1");
        expect(metadata["liblib-image"].additionalNetwork).toEqual([{ modelId: first, weight: 0 }]);
    });

    test("project style quotes use catalog default weights and preserve explicit zero", () => {
        const current = config();
        const catalogModel = current.channels[0].modelCosts![0].capabilityConfig!.image!.lora!.models[0];
        const style = createStyleProfileSnapshot({ presetId: "style", title: "风格", description: "", tags: [], prompt: "", executionPolicy: "strict-assets", assets: [{ id: "style-lora", title: "画风", kind: "lora", provider: "liblib", status: "validated", version: first }] });
        const weights = () => liblibLoraQuoteOptions(current, undefined, style)?.["liblib-image"].additionalNetwork.map((item) => item.weight);
        expect(weights()).toEqual([0.6]);
        catalogModel.defaultWeight = 0;
        expect(weights()).toEqual([0]);
        delete catalogModel.defaultWeight;
        expect(weights()).toEqual([0.8]);
        catalogModel.defaultWeight = 0.6;
        style.assets[0].weight = 0;
        expect(weights()).toEqual([0]);
    });
});
