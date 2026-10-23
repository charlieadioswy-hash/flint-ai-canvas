import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelCompatibilityError } from "@/lib/model-selection";
import { encodeChannelModel, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { ControlNetParameters } from "./generation-contract.generated";
import { controlNetBaseModel, controlNetBaseModelError, controlNetDefaultModel, controlNetDefaultPreprocessor, controlNetDefaultType, controlNetModels, controlNetPreprocessors, controlNetType, controlNetTypes } from "./controlnet-options";

export type ScreenGenerationSettings = {
    controlType?: string;
    preprocessor?: string;
    processorParameters?: Record<string, number>;
    controlModel: string;
    strength: number;
    start: number;
    end: number;
    lowThreshold: number;
    highThreshold: number;
    resolution: number;
    steps: number;
    sampler: number;
    cfgScale: number;
    seed: number;
    denoisingStrength: number;
    negativePrompt: string;
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
    if (!controls?.supported || !controlNetPreprocessors(controls).length) return "当前模型没有启用受支持的 ControlNet 预处理器";
    const baseError = controlNetBaseModelError(controls, defaults);
    if (baseError) return baseError;
    if (!controlNetBaseModel(controls, defaults)) return "尚未配置 ControlNet 基础算法，请联系管理员选择 SD 1.5、SDXL 或 F.1";
    if (!controlNetTypes(controls).some((type) => controlNetModels(controls, type.id, defaults).length)) return "当前模型未配置兼容的 ControlNet 控制模型，请联系管理员";
    if (protocol === "liblib-image" && (!defaults.family || !(hasReference ? defaults.imageToImageTemplateUuid || defaults.templateUuid : defaults.textToImageTemplateUuid || defaults.templateUuid))) return "当前模型缺少生成模板默认参数，请联系管理员";
    return "";
}

export function screenModels(config: AiConfig) {
    return selectableModelsByCapability(config, "image").filter((model) => !screenModelError(config, model));
}

export function screenInpaintError(config: AiConfig, model: string) {
    const error = screenModelError(config, model, true);
    if (error) return error;
    const { protocol, defaults } = screenModelDefaults(config, model);
    if (protocol !== "liblib-image" || defaults.family !== "sd") return "局部重绘目前支持 Liblib SD / SDXL 模型，请选择对应模型";
    if (!modelCapabilityConfigFor(config, model).image?.references.maskSupported) return "当前模型未启用局部重绘，请管理员确认模板支持后开启蒙版能力";
    return "";
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
    const number = (key: string, fallback: number) => (typeof defaults[key] === "number" && Number.isFinite(defaults[key]) ? (defaults[key] as number) : fallback);
    const controls = modelCapabilityConfigFor(config, model).image?.controlNet;
    const controlType = controlNetDefaultType(controls, defaults);
    const preprocessor = controlNetDefaultPreprocessor(controls, controlType, defaults);
    const controlModel = controlNetDefaultModel(controls, controlType, defaults, preprocessor?.id);
    return {
        controlType,
        preprocessor: preprocessor?.id || "",
        processorParameters: Object.fromEntries((preprocessor?.parameters || []).map((parameter) => [parameter.name, parameter.default])),
        controlModel,
        strength: 0.9,
        start: 0,
        end: 0.9,
        lowThreshold: 100,
        highThreshold: 200,
        resolution: 1024,
        steps: number("steps", 20),
        sampler: number("sampler", 15),
        cfgScale: number("cfgScale", 7),
        seed: number("seed", -1),
        denoisingStrength: number("denoisingStrength", 0.75),
        negativePrompt: String(defaults.negativePrompt ?? "text, watermark, logo, blurry, low quality"),
    };
}

export function screenControlParameters(settings: ScreenGenerationSettings): ControlNetParameters {
    const preprocessor = settings.preprocessor ?? "canny";
    return {
        ...(settings.controlType ? { controlType: settings.controlType } : {}),
        preprocessor,
        model: settings.controlModel,
        strength: settings.strength,
        start: settings.start,
        end: settings.end,
        pixelPerfect: true,
        controlMode: "balanced",
        resizeMode: "stretch",
        ...(preprocessor === "canny" ? { canny: { resolution: settings.resolution, lowThreshold: settings.lowThreshold, highThreshold: settings.highThreshold } } : { processorParameters: settings.processorParameters || {} }),
    };
}

export function screenSettingsFromControl(settings: ScreenGenerationSettings, parameters: ControlNetParameters): ScreenGenerationSettings {
    return { ...settings, controlType: controlNetType(parameters), preprocessor: parameters.preprocessor, controlModel: parameters.model, strength: parameters.strength, start: parameters.start, end: parameters.end, processorParameters: parameters.processorParameters ? { ...parameters.processorParameters } : undefined, resolution: parameters.canny?.resolution ?? settings.resolution, lowThreshold: parameters.canny?.lowThreshold ?? settings.lowThreshold, highThreshold: parameters.canny?.highThreshold ?? settings.highThreshold };
}

export function screenProviderOptions(config: AiConfig, model: string, settings: ScreenGenerationSettings, hasReference: boolean, inpaint = false) {
    const { defaults, protocol } = screenModelDefaults(config, model);
    const options: Record<string, unknown> = { ...defaults };
    if (protocol === "liblib-image") {
        Object.assign(options, { steps: settings.steps, sampler: settings.sampler, cfgScale: settings.cfgScale, seed: settings.seed, denoisingStrength: settings.denoisingStrength, negativePrompt: settings.negativePrompt });
        options.templateUuid = defaults.templateUuid || (hasReference ? defaults.imageToImageTemplateUuid : defaults.textToImageTemplateUuid);
        // The screen mask is opaque grayscale: white redraws, black preserves.
        if (inpaint) options.inpaintMaskMode = "luminance";
        else delete options.inpaintMaskMode;
    }
    return { [protocol]: options };
}
