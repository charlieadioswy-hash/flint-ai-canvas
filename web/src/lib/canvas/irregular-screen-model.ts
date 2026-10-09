import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelCompatibilityError } from "@/lib/model-selection";
import { encodeChannelModel, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { ControlNetParameters } from "./generation-contract.generated";

export type ScreenGenerationSettings = {
    controlModel: string; strength: number; start: number; end: number;
    lowThreshold: number; highThreshold: number; resolution: number;
    steps: number; sampler: number; cfgScale: number; seed: number;
    denoisingStrength: number; negativePrompt: string;
};

export function screenModelDefaults(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    const cost = channel.modelCosts?.find((item) => item.model === modelOptionName(model));
    return { channel, cost, protocol: cost?.protocol || channel.interfaceType || "", defaults: cost?.defaultOptions || {} };
}

export function screenModelError(config: AiConfig, model: string, hasReference = false) {
    if (!model) return "暂无可用的异形屏模型，请管理员启用结构控制并配置默认参数";
    if (!selectableModelsByCapability(config, "image").includes(model)) return "当前模型已停用或不在可用图片模型目录中，请重新选择";
    const error = modelCompatibilityError(config, model, { capability: "image", controlNetUnits: 1, input: { imageCount: hasReference ? 1 : 0, characterCount: 0, videoCount: 0, audioCount: 0, textCount: 0 } });
    if (error) return error;
    const { channel, cost, defaults, protocol } = screenModelDefaults(config, model);
    if (channel.scope !== "system" || channel.enabled === false || cost?.available === false) return "请选择可用的后台渠道模型";
    const controls = modelCapabilityConfigFor(config, model).image?.controlNet;
    if (!controls?.preprocessors.includes("canny")) return "当前模型没有启用 Canny 结构控制";
    const defaultControl = typeof defaults.controlNetModel === "string" ? defaults.controlNetModel.trim() : "";
    if (!defaultControl && !controls.models?.length) return "当前模型未配置推荐控制模型，请联系管理员";
    if (defaultControl && controls.models?.length && !controls.models.includes(defaultControl)) return "推荐控制模型不在当前允许的控制模型目录中，请联系管理员";
    if (protocol === "liblib-image" && (!defaults.family || !(hasReference ? defaults.imageToImageTemplateUuid || defaults.templateUuid : defaults.textToImageTemplateUuid || defaults.templateUuid))) return "当前模型缺少生成模板默认参数，请联系管理员";
    return "";
}

export function screenModels(config: AiConfig) {
    return selectableModelsByCapability(config, "image").filter((model) => !screenModelError(config, model));
}

export function screenPickerConfig(config: AiConfig): AiConfig {
    const models = screenModels(config);
    const allowed = new Set(models);
    // ModelPicker rebuilds its options from channels, so its source catalog must
    // carry the same screen-specific restrictions as the visible model arrays.
    const channels = config.channels.flatMap((channel) => {
        const channelModels = channel.models.filter((model) => allowed.has(encodeChannelModel(channel.id, modelOptionName(model))));
        if (!channelModels.length) return [];
        return [{ ...channel, models: channelModels, modelCosts: channel.modelCosts?.filter((cost) => allowed.has(encodeChannelModel(channel.id, cost.model))) }];
    });
    return { ...config, channels, models, imageModels: models };
}

export function screenDefaultSettings(config: AiConfig, model: string): ScreenGenerationSettings {
    const { defaults } = screenModelDefaults(config, model);
    const number = (key: string, fallback: number) => typeof defaults[key] === "number" && Number.isFinite(defaults[key]) ? defaults[key] as number : fallback;
    const controls = modelCapabilityConfigFor(config, model).image?.controlNet?.models;
    const defaultControl = typeof defaults.controlNetModel === "string" ? defaults.controlNetModel.trim() : "";
    const controlModel = defaultControl && (!controls?.length || controls.includes(defaultControl)) ? defaultControl : defaultControl ? "" : controls?.[0] || "";
    return {
        controlModel,
        strength: 0.9, start: 0, end: 0.9, lowThreshold: 100, highThreshold: 200, resolution: 1024,
        steps: number("steps", 20), sampler: number("sampler", 15), cfgScale: number("cfgScale", 7), seed: number("seed", -1),
        denoisingStrength: number("denoisingStrength", 0.75), negativePrompt: String(defaults.negativePrompt ?? "text, watermark, logo, blurry, low quality"),
    };
}

export function screenControlParameters(settings: ScreenGenerationSettings): ControlNetParameters {
    return { preprocessor: "canny", model: settings.controlModel, strength: settings.strength, start: settings.start, end: settings.end, pixelPerfect: true, controlMode: "balanced", resizeMode: "stretch", canny: { resolution: settings.resolution, lowThreshold: settings.lowThreshold, highThreshold: settings.highThreshold } };
}

export function screenProviderOptions(config: AiConfig, model: string, settings: ScreenGenerationSettings, hasReference: boolean) {
    const { defaults, protocol } = screenModelDefaults(config, model);
    const options: Record<string, unknown> = { ...defaults };
    if (protocol === "liblib-image") {
        Object.assign(options, { steps: settings.steps, sampler: settings.sampler, cfgScale: settings.cfgScale, seed: settings.seed, denoisingStrength: settings.denoisingStrength, negativePrompt: settings.negativePrompt });
        options.templateUuid = defaults.templateUuid || (hasReference ? defaults.imageToImageTemplateUuid : defaults.textToImageTemplateUuid);
    }
    return { [protocol]: options };
}
