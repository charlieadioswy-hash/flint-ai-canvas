import { describe, expect, test } from "bun:test";
import { screenControlParameters, screenDefaultSettings, screenInpaintError, screenModelError, screenModels, screenPickerConfig, screenProviderOptions, screenSettingsForGenerationMode, screenSettingsFromControl, screenSettingsFromControlSelection } from "../src/lib/canvas/irregular-screen-model";
import { applyScreenCarExample, screenCarExample } from "../src/lib/canvas/irregular-screen-example";
import { switchControlNetType } from "../src/lib/canvas/controlnet-options";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { createModelChannel, defaultConfig, encodeChannelModel, selectableModelsByCapability, type AiConfig } from "../src/stores/use-config-store";

function setup(options: { id?: string; scope?: "system" | "user"; enabled?: boolean; available?: boolean; supported?: boolean; preprocessors?: string[]; controlModels?: string[]; maxImages?: number; defaults?: Record<string, unknown> } = {}) {
    const id = options.id || "screen-channel";
    const model = encodeChannelModel(id, "screen-model");
    const profile = defaultImageCapabilityConfig("liblib-image");
    const channel = createModelChannel({
        id,
        scope: options.scope || "system",
        enabled: options.enabled,
        name: id,
        baseUrl: "https://provider.example",
        apiKey: "system",
        interfaceType: "liblib-image",
        models: ["screen-model"],
        modelCosts: [
            {
                model: "screen-model",
                capability: "image",
                protocol: "liblib-image",
                available: options.available,
                billingMode: "fixed_request",
                unitPriceMicrocredits: 1,
                defaultOptions: options.defaults || { family: "sd", controlNetModel: "canny-model", textToImageTemplateUuid: "text-template", imageToImageTemplateUuid: "image-template", steps: 20, sampler: 15, cfgScale: 7 },
                capabilityConfig: {
                    version: 1,
                    image: {
                        ...profile,
                        references: { ...profile.references, maxImages: options.maxImages ?? 1 },
                        controlNet: { supported: options.supported ?? true, maxUnits: 1, baseModel: "sdxl", preprocessors: options.preprocessors || ["canny"], models: options.controlModels || ["canny-model"], modelCatalog: (options.controlModels || ["canny-model"]).map((id) => ({ id, name: id, baseModel: "sdxl", controlTypes: ["canny"] })) },
                    },
                },
            },
        ],
    });
    const config: AiConfig = { ...defaultConfig, channels: [channel], model, imageModel: model };
    return { config, channel, model };
}

const cannyXL = "b6806516962f4e1599a93ac4483c3d23";
const inpaintXL = "a311363995dd4f2fa42ee3fc9582d920";
const randomInpaintXL = "3161fc68c59847b0ad826a9fb18c857f";
function inpaintSetup() {
    return setup({ preprocessors: ["canny", "inpaint_global_harmonious", "inpaint_only", "inpaint_only+lama"], controlModels: [cannyXL, inpaintXL, randomInpaintXL], defaults: { family: "sd", controlNetModel: cannyXL, textToImageTemplateUuid: "text-template", imageToImageTemplateUuid: "image-template" } });
}

describe("irregular screen model settings", () => {
    test("Liblib text-to-image prefers available Inpaint with official empty processor parameters", () => {
        const { config, model } = inpaintSetup();
        const settings = screenDefaultSettings(config, model);
        expect(settings).toMatchObject({ controlType: "inpaint", preprocessor: "inpaint_global_harmonious", controlModel: inpaintXL, strength: 1, start: 0, end: 1 });
        const parameters = screenControlParameters(settings);
        expect(parameters).toMatchObject({ processorParameters: {}, pixelPerfect: false, controlMode: "balanced", resizeMode: "stretch" });
        expect(parameters).not.toHaveProperty("canny");
        expect(screenDefaultSettings(config, model, "img2img")).toMatchObject({ controlType: "canny", controlModel: cannyXL, strength: 0.9, end: 0.9, pixelPerfect: true });
    });

    test("Liblib default inference selects Inpaint from a registered SDXL Canny default without an explicit base or allowlist", () => {
        const { config, model, channel } = inpaintSetup();
        channel.modelCosts![0].capabilityConfig!.image!.controlNet = { supported: true, maxUnits: 1, preprocessors: ["canny", "inpaint_global_harmonious"] };

        expect(screenModelError(config, model)).toBe("");
        const settings = screenDefaultSettings(config, model, "text2img");
        expect(settings).toMatchObject({ controlType: "inpaint", preprocessor: "inpaint_global_harmonious", controlModel: inpaintXL, strength: 1, start: 0, end: 1, pixelPerfect: false });
        expect(screenControlParameters(settings)).toMatchObject({ processorParameters: {} });
        expect(screenControlParameters(settings)).not.toHaveProperty("canny");
    });

    test("Liblib default inference respects a Canny-only model allowlist", () => {
        const { config, model, channel } = inpaintSetup();
        channel.modelCosts![0].capabilityConfig!.image!.controlNet = { supported: true, maxUnits: 1, preprocessors: ["canny", "inpaint_global_harmonious"], models: [cannyXL] };

        expect(screenModelError(config, model)).toBe("");
        expect(screenDefaultSettings(config, model, "text2img")).toMatchObject({ controlType: "canny", preprocessor: "canny", controlModel: cannyXL, pixelPerfect: true });
    });

    test("Liblib default inference avoids Inpaint without a known compatible base", () => {
        const { config, model, channel } = inpaintSetup();
        channel.modelCosts![0].capabilityConfig!.image!.controlNet = { supported: true, maxUnits: 1, preprocessors: ["canny", "inpaint_global_harmonious"] };
        channel.modelCosts![0].defaultOptions!.controlNetModel = "unregistered-control-model";

        expect(screenModelError(config, model)).not.toBe("");
        expect(screenDefaultSettings(config, model, "text2img")).toMatchObject({ controlType: "canny", preprocessor: "canny" });
    });

    test.each(["inpaint_global_harmonious", "inpaint_only", "inpaint_only+lama"])("uses the enabled Inpaint processor %s without adding Canny fields", (preprocessor) => {
        const { config, model, channel } = inpaintSetup();
        channel.modelCosts![0].capabilityConfig!.image!.controlNet!.preprocessors = ["canny", preprocessor];
        const settings = screenDefaultSettings(config, model);
        expect(settings).toMatchObject({ controlType: "inpaint", preprocessor, controlModel: inpaintXL, processorParameters: {} });
        expect(screenControlParameters(settings)).not.toHaveProperty("canny");
    });

    test("restricted processors, model allowlists and other protocols keep a compatible fallback", () => {
        const { config, model, channel } = inpaintSetup();
        const controls = channel.modelCosts![0].capabilityConfig!.image!.controlNet!;
        controls.models = [cannyXL];
        expect(screenDefaultSettings(config, model)).toMatchObject({ controlType: "canny", controlModel: cannyXL });
        controls.models = [cannyXL, randomInpaintXL];
        expect(screenDefaultSettings(config, model)).toMatchObject({ controlType: "inpaint", controlModel: randomInpaintXL });
        controls.models = [cannyXL, inpaintXL];
        controls.preprocessors = ["canny"];
        expect(screenDefaultSettings(config, model)).toMatchObject({ controlType: "canny", controlModel: cannyXL });
        controls.preprocessors.push("inpaint_only");
        channel.modelCosts![0].protocol = "future-control-provider";
        expect(screenDefaultSettings(config, model)).toMatchObject({ controlType: "canny", controlModel: cannyXL });
    });

    test("entering text-to-image resets only controls while repeated mode selection keeps manual choices", () => {
        const { config, model } = inpaintSetup();
        const settings = { ...screenDefaultSettings(config, model, "img2img"), strength: 0.4, start: 0.2, end: 0.6, steps: 37, sampler: 9, seed: 12345, cfgScale: 4.5, denoisingStrength: 0.3, negativePrompt: "manual negative" };
        expect(screenSettingsForGenerationMode(config, model, settings, "text2img", "text2img")).toBe(settings);
        const changed = screenSettingsForGenerationMode(config, model, settings, "img2img", "text2img");
        expect(changed).toMatchObject({ controlType: "inpaint", controlModel: inpaintXL, strength: 1, start: 0, end: 1, pixelPerfect: false, steps: 37, sampler: 9, seed: 12345, cfgScale: 4.5, denoisingStrength: 0.3, negativePrompt: "manual negative" });
        expect(screenControlParameters(changed)).not.toHaveProperty("canny");
        expect(screenSettingsForGenerationMode(config, model, changed, "text2img", "img2img")).toBe(changed);
    });

    test("saved control parameters override the new default and selection resets apply only when entering Inpaint", () => {
        const { config, model, channel } = inpaintSetup();
        const defaults = screenDefaultSettings(config, model);
        const saved = { ...screenControlParameters(defaults), preprocessor: "inpaint_only+lama", model: randomInpaintXL, strength: 0.35, start: 0.2, end: 0.55 };
        expect(screenControlParameters(screenSettingsFromControl(defaults, saved))).toEqual(saved);
        expect(screenControlParameters(screenSettingsFromControlSelection(defaults, saved))).toEqual(saved);
        for (const pixelPerfect of [true, false]) {
            const restored = screenSettingsFromControl(defaults, { ...saved, pixelPerfect });
            expect(screenControlParameters(restored)).toEqual({ ...saved, pixelPerfect });
        }
        const legacy = { ...saved, pixelPerfect: undefined };
        expect(screenControlParameters(screenSettingsFromControl(defaults, legacy)).pixelPerfect).toBe(true);
        const canny = { ...screenDefaultSettings(config, model, "img2img"), strength: 0.3, start: 0.1, end: 0.4 };
        const selected = switchControlNetType(screenControlParameters(canny), "inpaint", channel.modelCosts![0].capabilityConfig!.image!.controlNet, channel.modelCosts![0].defaultOptions);
        const next = screenSettingsFromControlSelection({ ...canny, controlType: "inpaint", seed: 8765 }, selected, canny);
        expect(screenControlParameters(next)).toMatchObject({ controlType: "inpaint", strength: 1, start: 0, end: 1, pixelPerfect: false, processorParameters: {} });
        expect(screenControlParameters(next)).not.toHaveProperty("canny");
        expect(next.seed).toBe(8765);
    });

    test("the car example preserves non-Canny controls while applying general generation settings", () => {
        const { config, model } = inpaintSetup();
        const settings = { ...screenDefaultSettings(config, model), strength: 0.45, start: 0.15, end: 0.85 };
        const applied = applyScreenCarExample(settings);
        expect(screenControlParameters(applied)).toEqual(screenControlParameters(settings));
        expect(applied).toMatchObject({ seed: screenCarExample.settings.seed, steps: screenCarExample.settings.steps, negativePrompt: screenCarExample.settings.negativePrompt });
        const canny = applyScreenCarExample(screenDefaultSettings(config, model, "img2img"));
        expect(screenControlParameters(canny)).toMatchObject({ controlType: "canny", strength: 0.6, start: 0, end: 0.6, canny: { resolution: 512, lowThreshold: 100, highThreshold: 200 } });
    });

    test("lists only enabled available system image models with usable Canny controls", () => {
        const entries = [
            setup({ id: "usable" }),
            setup({ id: "user", scope: "user" }),
            setup({ id: "disabled", enabled: false }),
            setup({ id: "unavailable", available: false }),
            setup({ id: "unsupported", supported: false }),
            setup({ id: "depth", preprocessors: ["depth"] }),
            setup({ id: "missing-template", defaults: { controlNetModel: "canny-model", family: "sd" } }),
        ];
        const config = { ...entries[0].config, channels: entries.map((entry) => entry.channel) };
        expect(screenModels(config)).toEqual([entries[0].model]);
    });

    test("the actual picker catalog excludes rejected channels and models without changing the shared config", () => {
        const entries = [
            setup({ id: "usable" }),
            setup({ id: "user", scope: "user" }),
            setup({ id: "disabled", enabled: false }),
            setup({ id: "unavailable", available: false }),
            setup({ id: "unsupported", supported: false }),
            setup({ id: "missing-template", defaults: { controlNetModel: "canny-model", family: "sd" } }),
        ];
        const usable = entries[0];
        usable.channel.models.push("unconfigured-sibling");
        usable.channel.modelCosts!.push({ ...usable.channel.modelCosts![0], model: "unconfigured-sibling", defaultOptions: { controlNetModel: "canny-model", family: "sd" } });
        const config = { ...usable.config, channels: entries.map((entry) => entry.channel), models: ["stale-snapshot-model"], imageModels: ["stale-snapshot-model"] };
        const original = structuredClone(config);
        const picker = screenPickerConfig(config);

        expect(selectableModelsByCapability(picker, "image")).toEqual([usable.model]);
        expect(picker.models).toEqual([usable.model]);
        expect(picker.imageModels).toEqual([usable.model]);
        expect(picker.channels.map((channel) => channel.id)).toEqual(["usable"]);
        expect(picker.channels[0].models).toEqual(["screen-model"]);
        expect(picker.channels[0].modelCosts?.map((cost) => cost.model)).toEqual(["screen-model"]);
        expect(config).toEqual(original);
        expect(selectableModelsByCapability(config, "image")).toContain(entries[1].model);
        expect(selectableModelsByCapability(config, "image")).toContain("usable::unconfigured-sibling");
    });

    test("an empty screen picker cannot rebuild rejected models from the original channels", () => {
        const { config } = setup({ scope: "user" });
        const picker = screenPickerConfig(config);
        expect(selectableModelsByCapability(picker, "image")).toEqual([]);
        expect(picker.channels).toEqual([]);
        expect(config.channels).toHaveLength(1);
    });

    test("falls back to an allowed control model when the configured recommendation was removed", () => {
        const { config, model } = setup({ defaults: { family: "sd", templateUuid: "template", controlNetModel: "removed-model" } });
        expect(screenModelError(config, model)).toBe("");
        expect(screenModels(config)).toEqual([model]);
        expect(screenDefaultSettings(config, model).controlModel).toBe("canny-model");
    });

    test("rejects unknown and disabled selections instead of falling back to another channel", () => {
        const { config, model } = setup();
        expect(screenModelError(config, "missing-channel::screen-model")).not.toBe("");
        expect(screenModelError({ ...config, channels: [{ ...config.channels[0], enabled: false }] }, model)).not.toBe("");
    });

    test("uses the configured control list when no recommended control model is present", () => {
        const { config, model } = setup({ defaults: { family: "sd", templateUuid: "template" }, controlModels: ["approved-canny"] });
        expect(screenModelError(config, model)).toBe("");
        expect(screenDefaultSettings(config, model).controlModel).toBe("approved-canny");
    });

    test("preserves zero defaults instead of replacing them with nonzero fallbacks", () => {
        const { config, model } = setup({ defaults: { family: "sd", templateUuid: "template", controlNetModel: "canny-model", sampler: 0, seed: 0, cfgScale: 0, denoisingStrength: 0, steps: 12 } });
        const settings = screenDefaultSettings(config, model);
        expect(settings).toMatchObject({ sampler: 0, seed: 0, cfgScale: 0, denoisingStrength: 0, steps: 12 });
        expect(screenProviderOptions(config, model, settings, "img2img")["liblib-image"]).toMatchObject({ sampler: 0, seed: 0, cfgScale: 0, denoisingStrength: 0 });
    });

    test("switches Liblib templates according to the explicit generation mode", () => {
        const { config, model } = setup();
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, "text2img")["liblib-image"].templateUuid).toBe("text-template");
        expect(screenProviderOptions(config, model, settings, "img2img")["liblib-image"].templateUuid).toBe("image-template");
        expect(screenProviderOptions(config, model, settings, "text2img")["liblib-image"].templateUuid).toBe("text-template");
        expect(config.channels[0].modelCosts?.[0].defaultOptions).not.toHaveProperty("templateUuid");
    });

    test("uses an explicit shared template when operation-specific defaults are absent", () => {
        const { config, model } = setup({ defaults: { family: "sd", controlNetModel: "canny-model", templateUuid: "shared-template" } });
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, "text2img")["liblib-image"].templateUuid).toBe("shared-template");
        expect(screenProviderOptions(config, model, settings, "img2img")["liblib-image"].templateUuid).toBe("shared-template");
    });

    test("prioritizes an explicit fixed template over operation-specific defaults", () => {
        const { config, model } = setup({ defaults: { family: "sd", controlNetModel: "canny-model", templateUuid: "fixed-template", textToImageTemplateUuid: "text-template", imageToImageTemplateUuid: "image-template" } });
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, "text2img")["liblib-image"].templateUuid).toBe("fixed-template");
        expect(screenProviderOptions(config, model, settings, "img2img")["liblib-image"].templateUuid).toBe("fixed-template");
    });

    test("requires the correct operation template and content-reference capacity", () => {
        const noImageTemplate = setup({ defaults: { family: "sd", controlNetModel: "canny-model", textToImageTemplateUuid: "text-only" } });
        expect(screenModelError(noImageTemplate.config, noImageTemplate.model)).toBe("");
        expect(screenModelError(noImageTemplate.config, noImageTemplate.model, true)).toContain("模板");
        const noReferences = setup({ maxImages: 0 });
        expect(screenModelError(noReferences.config, noReferences.model)).toBe("");
        expect(screenModelError(noReferences.config, noReferences.model, true)).toContain("参考图");
    });

    test("maps Canny settings with full-frame coordinates and no crop", () => {
        const { config, model } = setup();
        const settings = { ...screenDefaultSettings(config, model), strength: 1.1, start: 0.1, end: 0.8, lowThreshold: 80, highThreshold: 160, resolution: 768 };
        expect(screenControlParameters(settings)).toEqual({
            controlType: "canny",
            preprocessor: "canny",
            model: "canny-model",
            strength: 1.1,
            start: 0.1,
            end: 0.8,
            pixelPerfect: true,
            controlMode: "balanced",
            resizeMode: "stretch",
            canny: { lowThreshold: 80, highThreshold: 160, resolution: 768 },
        });
    });

    test("local repaint requires an explicitly enabled SD image-to-image template", () => {
        const { config, model, channel } = setup();
        expect(screenInpaintError(config, model)).toContain("未启用蒙版重绘");
        channel.modelCosts![0].capabilityConfig!.image!.references.maskSupported = true;
        expect(screenInpaintError(config, model)).toBe("");
        channel.modelCosts![0].defaultOptions!.family = "f1";
        expect(screenInpaintError(config, model)).toContain("F.1");
        channel.modelCosts![0].defaultOptions!.family = "sd";
        delete channel.modelCosts![0].defaultOptions!.imageToImageTemplateUuid;
        expect(screenInpaintError(config, model)).toContain("模板");
    });

    test("screen inpaint sends white-redraw semantics without leaking them into normal generation", () => {
        const { config, model } = setup();
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, "img2img", true)["liblib-image"]).toMatchObject({ templateUuid: "image-template", inpaintMaskMode: "luminance", denoisingStrength: 0.75 });
        config.channels[0].modelCosts![0].defaultOptions!.inpaintMaskMode = "alpha";
        expect(screenProviderOptions(config, model, settings, "text2img", true)["liblib-image"]).not.toHaveProperty("inpaintMaskMode");
        expect(screenProviderOptions(config, model, settings, "img2img", false)["liblib-image"]).not.toHaveProperty("inpaintMaskMode");
        expect(config.channels[0].modelCosts![0].defaultOptions!.inpaintMaskMode).toBe("alpha");
    });
});
