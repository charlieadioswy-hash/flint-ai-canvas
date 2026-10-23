import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import type { ControlNetParameters } from "./generation-contract.generated";
import { CONTROLNET_TYPES, CONTROLNET_PREPROCESSORS, LIBLIB_CONTROLNET_MODELS } from "./controlnet-catalog.generated";

export type ControlNetProfile = NonNullable<ImageCapabilityConfig["controlNet"]>;
export type ControlNetBaseModel = NonNullable<ControlNetProfile["baseModel"]>;
export type ControlNetModel = { id: string; name: string; controlTypes: string[]; baseModel: string; preprocessors?: string[] };

export function controlNetModelId(id: string) {
    return id.trim().toLowerCase();
}

export function controlNetModelCatalog(profile?: ControlNetProfile): ControlNetModel[] {
    const catalog = new Map<string, ControlNetModel>(LIBLIB_CONTROLNET_MODELS.map((model) => [controlNetModelId(model.id), model]));
    for (const model of profile?.modelCatalog || []) {
        const id = controlNetModelId(model.id);
        if (!catalog.has(id)) catalog.set(id, model);
    }
    return [...catalog.values()];
}

function resolveControlNetBaseModel(profile?: ControlNetProfile, defaults: Record<string, unknown> = {}): ControlNetBaseModel | undefined {
    if (profile?.baseModel) return profile.baseModel;
    if (defaults.family === "f1") return "f1";
    if (defaults.family !== "f1" && typeof defaults.checkPointId === "string" && controlNetModelId(defaults.checkPointId) === "0ea388c7eb854be3ba3c6f65aac6bfd3") return "sdxl";
    const catalog = controlNetModelCatalog(profile);
    const ids = [...(profile?.models || []), ...(typeof defaults.controlNetModel === "string" ? [defaults.controlNetModel] : [])];
    const bases = new Set(ids.flatMap((id) => catalog.find((model) => controlNetModelId(model.id) === controlNetModelId(id))?.baseModel || []));
    if (bases.size !== 1) return undefined;
    const base = [...bases][0];
    return base === "sd15" || base === "sdxl" || base === "f1" ? base : undefined;
}

export function controlNetBaseModelError(profile?: ControlNetProfile, defaults: Record<string, unknown> = {}) {
    const base = resolveControlNetBaseModel(profile, defaults);
    if (defaults.family === "f1" && base && base !== "f1") return "ControlNet 基础算法与生成家族 F.1 不一致，请联系管理员配置";
    if (defaults.family === "sd" && base === "f1") return "ControlNet 基础算法 F.1 与生成家族 SD 不一致，请联系管理员配置";
    if (defaults.family !== "f1" && typeof defaults.checkPointId === "string" && controlNetModelId(defaults.checkPointId) === "0ea388c7eb854be3ba3c6f65aac6bfd3" && base && base !== "sdxl") return "ControlNet 基础算法与当前 SDXL Checkpoint 不一致，请联系管理员配置";
    return "";
}

export function controlNetBaseModel(profile?: ControlNetProfile, defaults: Record<string, unknown> = {}): ControlNetBaseModel | undefined {
    return controlNetBaseModelError(profile, defaults) ? undefined : resolveControlNetBaseModel(profile, defaults);
}

export function controlNetPreprocessor(id: string) {
    return CONTROLNET_PREPROCESSORS.find((processor) => processor.id === id);
}

export function controlNetPreprocessorSupportsType(id: string, type: string) {
    const processor = controlNetPreprocessor(id);
    return Boolean(processor && (processor.controlType === type || processor.controlTypes?.includes(type)));
}

export function controlNetType(parameters: Pick<ControlNetParameters, "controlType" | "preprocessor">) {
    return parameters.controlType || controlNetPreprocessor(parameters.preprocessor)?.controlType || "";
}

export function controlNetTypeLabel(type: string) {
    return CONTROLNET_TYPES.find((item) => item.id === type)?.label || type;
}

export function controlNetPreprocessors(profile?: ControlNetProfile, type?: string) {
    const allowed = profile ? new Set(profile.preprocessors.map((id) => id.trim().toLowerCase())) : undefined;
    return CONTROLNET_PREPROCESSORS.filter((processor) => (!type || controlNetPreprocessorSupportsType(processor.id, type)) && (!allowed || allowed.has(processor.id)));
}

export function controlNetTypes(profile?: ControlNetProfile) {
    return CONTROLNET_TYPES.filter((type) => type.supported && type.id !== "none" && controlNetPreprocessors(profile, type.id).length);
}

export function controlNetModels(profile: ControlNetProfile | undefined, type: string, defaults: Record<string, unknown> = {}, preprocessor?: string) {
    const base = controlNetBaseModel(profile, defaults);
    if (!base) return [];
    const recommended = (preprocessor ? controlNetPreprocessor(preprocessor)?.recommendedModels || [] : []).map(controlNetModelId);
    const allowed = profile?.models?.map(controlNetModelId);
    const rank = (id: string) => { const index = recommended.indexOf(controlNetModelId(id)); return index < 0 ? recommended.length : index; };
    return controlNetModelCatalog(profile).filter((model) => model.baseModel === base && model.controlTypes.includes(type) && (!preprocessor || !model.preprocessors?.length || model.preprocessors.includes(preprocessor)) && ((type === "reference" && model.id === "") || !allowed?.length || allowed.includes(controlNetModelId(model.id)))).sort((left, right) => rank(left.id) - rank(right.id));
}

export function controlNetTypeUnavailableReason(type: string, profile?: ControlNetProfile, defaults: Record<string, unknown> = {}) {
    const definition = CONTROLNET_TYPES.find((item) => item.id === type);
    if (!definition?.supported) return "暂不支持";
    if (type === "none") return "请选择实际控制类型";
    if (!profile?.supported) return "后台未启用 ControlNet";
    const processors = controlNetPreprocessors(profile, type);
    if (!processors.length) return "后台未启用预处理器";
    if (controlNetBaseModelError(profile, defaults)) return "基础算法配置冲突";
    if (!controlNetBaseModel(profile, defaults)) return "后台未配置基础算法";
    if (processors.some((processor) => controlNetModels(profile, type, defaults, processor.id).length)) return "";
    if (profile.models?.length && processors.some((processor) => controlNetModels({ ...profile, models: [] }, type, defaults, processor.id).length)) return "后台未开放兼容模型";
    return "当前底模无兼容控制模型";
}

export function controlNetDefaultModel(profile: ControlNetProfile | undefined, type: string, defaults: Record<string, unknown> = {}, preprocessor?: string) {
    const models = controlNetModels(profile, type, defaults, preprocessor);
    const preferred = typeof defaults.controlNetModel === "string" ? controlNetModelId(defaults.controlNetModel) : "";
    const recommended = (preprocessor ? controlNetPreprocessor(preprocessor)?.recommendedModels || [] : []).map(controlNetModelId);
    return models.find((model) => controlNetModelId(model.id) === preferred)?.id ?? models.find((model) => recommended.includes(controlNetModelId(model.id)))?.id ?? models[0]?.id ?? "";
}

export function controlNetDefaultPreprocessor(profile: ControlNetProfile | undefined, type: string, defaults: Record<string, unknown> = {}) {
    const processors = controlNetPreprocessors(profile, type);
    const preferred = typeof defaults.controlNetModel === "string" ? controlNetModelId(defaults.controlNetModel) : "";
    return processors.find((processor) => processor.recommendedModels?.some((id) => controlNetModelId(id) === preferred) && controlNetModels(profile, type, defaults, processor.id).some((model) => controlNetModelId(model.id) === preferred)) || processors.find((processor) => controlNetModels(profile, type, defaults, processor.id).some((model) => controlNetModelId(model.id) === preferred)) || processors.find((processor) => controlNetModels(profile, type, defaults, processor.id).length) || processors[0];
}

export function controlNetDefaultType(profile?: ControlNetProfile, defaults: Record<string, unknown> = {}) {
    const types = controlNetTypes(profile).map((type) => type.id);
    const preferred = typeof defaults.controlNetModel === "string" ? controlNetModelId(defaults.controlNetModel) : undefined;
    const recommended = types.find((type) => controlNetModels(profile, type, defaults).some((model) => controlNetModelId(model.id) === preferred));
    return recommended || types.find((type) => type === "canny" && controlNetModels(profile, type, defaults).length) || types.find((type) => controlNetModels(profile, type, defaults).length) || types[0] || "canny";
}

export function switchControlNetPreprocessor(parameters: ControlNetParameters, id: string, profile?: ControlNetProfile, defaults: Record<string, unknown> = {}): ControlNetParameters {
    const processor = controlNetPreprocessor(id);
    const { canny: _canny, processorParameters: _processorParameters, ...common } = parameters;
    const values = Object.fromEntries((processor?.parameters || []).map((parameter) => [parameter.name, parameter.default]));
    const controlType = processor && controlNetPreprocessorSupportsType(id, controlNetType(parameters)) ? controlNetType(parameters) : processor?.controlType || parameters.controlType;
    const resetModel = profile && (processor?.recommendedModels?.length || !controlNetModels(profile, controlType || "", defaults, id).some((candidate) => controlNetModelId(candidate.id) === controlNetModelId(parameters.model)));
    const model = resetModel ? controlNetDefaultModel(profile, controlType || "", parameters.preprocessor !== id && processor?.recommendedModels?.length ? { ...defaults, controlNetModel: undefined } : defaults, id) : parameters.model;
    return {
        ...common,
        controlType,
        model,
        preprocessor: id,
        ...(id === "canny" ? { canny: { resolution: values.resolution, lowThreshold: values.lowThreshold, highThreshold: values.highThreshold } } : { processorParameters: values }),
    };
}

export function switchControlNetType(parameters: ControlNetParameters, type: string, profile?: ControlNetProfile, defaults: Record<string, unknown> = {}): ControlNetParameters {
    const processor = controlNetDefaultPreprocessor(profile, type, defaults);
    return { ...switchControlNetPreprocessor({ ...parameters, controlType: type }, processor?.id || ""), model: controlNetDefaultModel(profile, type, defaults, processor?.id) };
}

export function controlNetConfigurationError(parameters: ControlNetParameters, profile?: ControlNetProfile, defaults: Record<string, unknown> = {}, mode?: "text2img" | "img2img") {
    const processor = controlNetPreprocessor(parameters.preprocessor);
    const type = controlNetType(parameters);
    const definition = CONTROLNET_TYPES.find((item) => item.id === type);
    if (!definition?.supported) return definition?.description || "所选 Control Type 暂不支持";
    if (type === "none") return "None 只表示不预处理，请先选择实际控制类型";
    if (!processor || !controlNetPreprocessorSupportsType(processor.id, type)) return "请选择与 Control Type 对应的预处理器";
    if (mode && processor.modes?.length && !processor.modes.includes(mode)) return "所选预处理器仅支持文生图，请移除内容参考图或切换控制类型";
    if (!profile?.supported || !controlNetPreprocessors(profile, type).some((item) => item.id === parameters.preprocessor)) return "当前模型未启用所选预处理器，请联系管理员配置";
    const baseError = controlNetBaseModelError(profile, defaults);
    if (baseError) return baseError;
    if (!controlNetBaseModel(profile, defaults)) return "尚未配置 ControlNet 基础算法，请联系管理员选择 SD 1.5、SDXL 或 F.1";
    const models = controlNetModels(profile, type, defaults, processor.id);
    if (!models.length) return `当前基础算法没有可用的 ${controlNetTypeLabel(type)} 控制模型，请联系管理员配置目录`;
    if (!models.some((model) => controlNetModelId(model.id) === controlNetModelId(parameters.model))) return "所选控制模型与 Control Type 或基础算法不兼容，请重新选择";
    return "";
}
