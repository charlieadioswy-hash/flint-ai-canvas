import { modelCapabilityConfigFor, type ImageCapabilityConfig } from "@/lib/model-capabilities";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

export type LiblibLoraSelection = { modelId: string; weight?: number };
export type LiblibLoraProfile = NonNullable<ImageCapabilityConfig["lora"]>;
export const LIBLIB_LORA_PROTOCOL = "liblib-image";
export const LIBLIB_LORA_DEFAULT_WEIGHT = 0.8;

export function liblibLoraModelId(value: string) { return value.trim().toLowerCase(); }
export function liblibLoraBaseLabel(value?: string) { return ({ sd15: "SD 1.5", sdxl: "SDXL", f1: "F.1" } as Record<string, string>)[value || ""] || "未配置基础算法"; }

export function parseLiblibLoras(value: unknown): LiblibLoraSelection[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("LoRA 配置必须为列表，请移除后重新选择");
    if (value.length > 5) throw new Error("最多添加 5 个 LoRA");
    const seen = new Set<string>();
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => key !== "modelId" && key !== "weight")) throw new Error(`LoRA ${index + 1} 配置无效，请移除后重新选择`);
        const modelId = typeof item.modelId === "string" ? liblibLoraModelId(item.modelId) : "";
        if (!/^[a-f0-9]{32}$/.test(modelId)) throw new Error(`LoRA ${index + 1} 缺少有效模型版本`);
        if (seen.has(modelId)) throw new Error("不能重复添加同一个 LoRA");
        seen.add(modelId);
        const weight = item.weight === undefined ? LIBLIB_LORA_DEFAULT_WEIGHT : item.weight;
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < -4 || weight > 4) throw new Error(`LoRA ${index + 1} 的权重必须在 -4 到 4 之间`);
        return { modelId, weight };
    });
}

export function liblibLoraConfigurationError(value: unknown, profile?: LiblibLoraProfile, protocol = LIBLIB_LORA_PROTOCOL) {
    let selections: LiblibLoraSelection[];
    try { selections = parseLiblibLoras(value); }
    catch (error) { return error instanceof Error ? error.message : "LoRA 配置无效"; }
    if (!selections.length) return "";
    if (protocol !== LIBLIB_LORA_PROTOCOL || !profile?.supported) return "当前模型不支持已选 LoRA，请切换兼容模型或移除 LoRA";
    if (selections.length > Math.min(5, profile.maxNetworks)) return `当前模型最多添加 ${Math.min(5, profile.maxNetworks)} 个 LoRA`;
    for (const selection of selections) {
        const model = profile.models.find((item) => liblibLoraModelId(item.id) === selection.modelId);
        if (!model) return "已选 LoRA 不在当前模型的已登记目录中，请重新选择或移除";
        if (model.baseModel !== profile.baseModel) return `${model.name} 仅兼容 ${liblibLoraBaseLabel(model.baseModel)}，当前模型使用 ${liblibLoraBaseLabel(profile.baseModel)}，请更换或移除`;
    }
    return "";
}

export function liblibLoraContext(config: AiConfig, model = config.model) {
    const channel = resolveModelChannel(config, model);
    const cost = channel.modelCosts?.find((item) => item.model === modelOptionName(model));
    return { protocol: cost?.protocol || channel.interfaceType || "", profile: modelCapabilityConfigFor(config, model).image?.lora, defaults: cost?.defaultOptions || {} };
}
