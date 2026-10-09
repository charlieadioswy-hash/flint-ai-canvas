import { describe, expect, test } from "bun:test";
import { screenControlParameters, screenDefaultSettings, screenModelError, screenModels, screenPickerConfig, screenProviderOptions } from "../src/lib/canvas/irregular-screen-model";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { createModelChannel, defaultConfig, encodeChannelModel, selectableModelsByCapability, type AiConfig } from "../src/stores/use-config-store";

function setup(options: { id?: string; scope?: "system" | "user"; enabled?: boolean; available?: boolean; supported?: boolean; preprocessors?: string[]; controlModels?: string[]; maxImages?: number; defaults?: Record<string, unknown> } = {}) {
    const id = options.id || "screen-channel";
    const model = encodeChannelModel(id, "screen-model");
    const profile = defaultImageCapabilityConfig("liblib-image");
    const channel = createModelChannel({
        id, scope: options.scope || "system", enabled: options.enabled, name: id, baseUrl: "https://provider.example", apiKey: "system", interfaceType: "liblib-image", models: ["screen-model"],
        modelCosts: [{ model: "screen-model", capability: "image", protocol: "liblib-image", available: options.available, billingMode: "fixed_request", unitPriceMicrocredits: 1,
            defaultOptions: options.defaults || { family: "sd", controlNetModel: "canny-model", textToImageTemplateUuid: "text-template", imageToImageTemplateUuid: "image-template", steps: 20, sampler: 15, cfgScale: 7 },
            capabilityConfig: { version: 1, image: { ...profile, references: { ...profile.references, maxImages: options.maxImages ?? 1 }, controlNet: { supported: options.supported ?? true, maxUnits: 1, preprocessors: options.preprocessors || ["canny"], models: options.controlModels || ["canny-model"] } } },
        }],
    });
    const config: AiConfig = { ...defaultConfig, channels: [channel], model, imageModel: model };
    return { config, channel, model };
}

describe("irregular screen model settings", () => {
    test("lists only enabled available system image models with usable Canny controls", () => {
        const entries = [
            setup({ id: "usable" }), setup({ id: "user", scope: "user" }), setup({ id: "disabled", enabled: false }),
            setup({ id: "unavailable", available: false }), setup({ id: "unsupported", supported: false }), setup({ id: "depth", preprocessors: ["depth"] }),
            setup({ id: "missing-template", defaults: { controlNetModel: "canny-model", family: "sd" } }),
        ];
        const config = { ...entries[0].config, channels: entries.map((entry) => entry.channel) };
        expect(screenModels(config)).toEqual([entries[0].model]);
    });

    test("the actual picker catalog excludes rejected channels and models without changing the shared config", () => {
        const entries = [
            setup({ id: "usable" }), setup({ id: "user", scope: "user" }), setup({ id: "disabled", enabled: false }),
            setup({ id: "unavailable", available: false }), setup({ id: "unsupported", supported: false }),
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

    test("rejects a recommended control model outside the configured model allowlist", () => {
        const { config, model } = setup({ defaults: { family: "sd", templateUuid: "template", controlNetModel: "removed-model" } });
        expect(screenModelError(config, model)).not.toBe("");
        expect(screenModels(config)).toEqual([]);
        expect(screenDefaultSettings(config, model).controlModel).toBe("");
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
        expect(screenProviderOptions(config, model, settings, true)["liblib-image"]).toMatchObject({ sampler: 0, seed: 0, cfgScale: 0, denoisingStrength: 0 });
    });

    test("switches Liblib templates only when an ordinary content reference is present", () => {
        const { config, model } = setup();
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, false)["liblib-image"].templateUuid).toBe("text-template");
        expect(screenProviderOptions(config, model, settings, true)["liblib-image"].templateUuid).toBe("image-template");
        expect(screenProviderOptions(config, model, settings, false)["liblib-image"].templateUuid).toBe("text-template");
        expect(config.channels[0].modelCosts?.[0].defaultOptions).not.toHaveProperty("templateUuid");
    });

    test("uses an explicit shared template when operation-specific defaults are absent", () => {
        const { config, model } = setup({ defaults: { family: "sd", controlNetModel: "canny-model", templateUuid: "shared-template" } });
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, false)["liblib-image"].templateUuid).toBe("shared-template");
        expect(screenProviderOptions(config, model, settings, true)["liblib-image"].templateUuid).toBe("shared-template");
    });

    test("prioritizes an explicit fixed template over operation-specific defaults", () => {
        const { config, model } = setup({ defaults: { family: "sd", controlNetModel: "canny-model", templateUuid: "fixed-template", textToImageTemplateUuid: "text-template", imageToImageTemplateUuid: "image-template" } });
        const settings = screenDefaultSettings(config, model);
        expect(screenProviderOptions(config, model, settings, false)["liblib-image"].templateUuid).toBe("fixed-template");
        expect(screenProviderOptions(config, model, settings, true)["liblib-image"].templateUuid).toBe("fixed-template");
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
        expect(screenControlParameters(settings)).toEqual({ preprocessor: "canny", model: "canny-model", strength: 1.1, start: 0.1, end: 0.8, pixelPerfect: true, controlMode: "balanced", resizeMode: "stretch", canny: { lowThreshold: 80, highThreshold: 160, resolution: 768 } });
    });
});
