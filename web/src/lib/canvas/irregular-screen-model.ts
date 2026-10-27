import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelCompatibilityError } from "@/lib/model-selection";
import { encodeChannelModel, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { ControlNetParameters } from "./generation-contract.generated";
import type { ScreenGenerationMode } from "./irregular-screen-domain";
import { controlNetBaseModel, controlNetBaseModelError, controlNetDefaultModel, controlNetDefaultPreprocessor, controlNetDefaultType, controlNetModels, controlNetPreprocessors, controlNetType, controlNetTypes } from "./controlnet-options";
import { parseLiblibLoras, type LiblibLoraSelection } from "./liblib-lora";

export type ScreenGenerationSettings = {
    controlType?: string;
    preprocessor?: string;
    processorParameters?: Record<string, number>;
    controlModel: string;
    strength: number;
    start: number;
    end: number;
    pixelPerfect?: boolean;
    lowThreshold: number;
    highThreshold: number;
    resolution: number;
    steps: number;
    sampler: number;
    cfgScale: number;
    seed: number;
    denoisingStrength: number;
    negativePrompt: string;
    additionalNetwork?: LiblibLoraSelection[];
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
    if (protocol !== "liblib-image" || defaults.family !== "sd") return "蒙版重绘目前支持 Liblib SD / SDXL 模型，请选择对应模型";
    if (!modelCapabilityConfigFor(config, model).image?.references.maskSupported) return "当前模型未启用蒙版重绘，请管理员确认模板支持后开启蒙版能力";
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

export function screenDefaultSettings(config: AiConfig, model: string, generationMode: ScreenGenerationMode = "text2img"): ScreenGenerationSettings {
    const { defaults, protocol } = screenModelDefaults(config, model);
    const number = (key: string, fallback: number) => (typeof defaults[key] === "number" && Number.isFinite(defaults[key]) ? (defaults[key] as number) : fallback);
    const controls = modelCapabilityConfigFor(config, model).image?.controlNet;
    const inpaintProcessor = protocol === "liblib-image" && generationMode === "text2img" && controls?.supported
        ? controlNetPreprocessors(controls, "inpaint").find((processor) => controlNetModels(controls, "inpaint", defaults, processor.id).length)
        : undefined;
    const controlType = inpaintProcessor ? "inpaint" : controlNetDefaultType(controls, defaults);
    const preprocessor = inpaintProcessor || controlNetDefaultPreprocessor(controls, controlType, defaults);
    // Keep defaults for base inference; Inpaint uses the catalog's recommendation order.
    const controlModel = inpaintProcessor
        ? controlNetModels(controls, controlType, defaults, inpaintProcessor.id)[0]?.id || ""
        : controlNetDefaultModel(controls, controlType, defaults, preprocessor?.id);
    return {
        controlType,
        preprocessor: preprocessor?.id || "",
        processorParameters: Object.fromEntries((preprocessor?.parameters || []).map((parameter) => [parameter.name, parameter.default])),
        controlModel,
        strength: controlType === "inpaint" ? 1 : 0.9,
        start: 0,
        end: controlType === "inpaint" ? 1 : 0.9,
        pixelPerfect: controlType !== "inpaint",
        lowThreshold: 100,
        highThreshold: 200,
        resolution: 1024,
        steps: number("steps", 20),
        sampler: number("sampler", 15),
        cfgScale: number("cfgScale", 7),
        seed: number("seed", -1),
        denoisingStrength: number("denoisingStrength", 0.75),
        negativePrompt: String(defaults.negativePrompt ?? "text, watermark, logo, blurry, low quality"),
        additionalNetwork: protocol === "liblib-image" ? parseLiblibLoras(defaults.additionalNetwork) : [],
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
        pixelPerfect: settings.pixelPerfect ?? true,
        controlMode: "balanced",
        resizeMode: "stretch",
        ...(preprocessor === "canny" ? { canny: { resolution: settings.resolution, lowThreshold: settings.lowThreshold, highThreshold: settings.highThreshold } } : { processorParameters: settings.processorParameters || {} }),
    };
}

export function screenSettingsFromControl(settings: ScreenGenerationSettings, parameters: ControlNetParameters): ScreenGenerationSettings {
    return { ...settings, controlType: controlNetType(parameters), preprocessor: parameters.preprocessor, controlModel: parameters.model, strength: parameters.strength, start: parameters.start, end: parameters.end, pixelPerfect: parameters.pixelPerfect, processorParameters: parameters.processorParameters ? { ...parameters.processorParameters } : undefined, resolution: parameters.canny?.resolution ?? settings.resolution, lowThreshold: parameters.canny?.lowThreshold ?? settings.lowThreshold, highThreshold: parameters.canny?.highThreshold ?? settings.highThreshold };
}

export function screenSettingsFromControlSelection(settings: ScreenGenerationSettings, parameters: ControlNetParameters, previousSettings = settings): ScreenGenerationSettings {
    const selectsInpaint = controlNetType(parameters) === "inpaint" && controlNetType(screenControlParameters(previousSettings)) !== "inpaint";
    return screenSettingsFromControl(settings, selectsInpaint ? { ...parameters, strength: 1, start: 0, end: 1, pixelPerfect: false } : parameters);
}

export function screenSettingsForGenerationMode(config: AiConfig, model: string, settings: ScreenGenerationSettings, previousMode: ScreenGenerationMode, generationMode: ScreenGenerationMode): ScreenGenerationSettings {
    if (previousMode === generationMode || generationMode !== "text2img") return settings;
    return screenSettingsFromControl(settings, screenControlParameters(screenDefaultSettings(config, model, generationMode)));
}

export function screenProviderOptions(config: AiConfig, model: string, settings: ScreenGenerationSettings, generationMode: ScreenGenerationMode, inpaint = false) {
    const { defaults, protocol } = screenModelDefaults(config, model);
    const options: Record<string, unknown> = { ...defaults };
    if (protocol === "liblib-image") {
        Object.assign(options, { steps: settings.steps, sampler: settings.sampler, cfgScale: settings.cfgScale, seed: settings.seed, denoisingStrength: settings.denoisingStrength, negativePrompt: settings.negativePrompt, additionalNetwork: parseLiblibLoras(settings.additionalNetwork) });
        options.templateUuid = defaults.templateUuid || (generationMode === "img2img" ? defaults.imageToImageTemplateUuid : defaults.textToImageTemplateUuid);
        // The screen mask is opaque grayscale: white redraws, black preserves.
        if (generationMode === "img2img" && inpaint) options.inpaintMaskMode = "luminance";
        else delete options.inpaintMaskMode;
    }
    return { [protocol]: options };
}

export function screenSettingsFromProvider(settings: ScreenGenerationSettings, provider: Record<string, unknown>): ScreenGenerationSettings {
    const next = { ...settings };
    for (const key of ["steps", "sampler", "cfgScale", "seed", "denoisingStrength"] as const) if (typeof provider[key] === "number") next[key] = provider[key] as number;
    if (typeof provider.negativePrompt === "string") next.negativePrompt = provider.negativePrompt;
    if (provider.additionalNetwork !== undefined) next.additionalNetwork = parseLiblibLoras(provider.additionalNetwork);
    return next;
}

export function screenSettingsForModel(config: AiConfig, model: string, settings: ScreenGenerationSettings, generationMode: ScreenGenerationMode): ScreenGenerationSettings {
    return { ...screenDefaultSettings(config, model, generationMode), additionalNetwork: settings.additionalNetwork ? structuredClone(settings.additionalNetwork) : undefined };
}
