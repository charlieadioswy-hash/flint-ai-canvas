import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { LIBLIB_LORA_PROTOCOL, liblibLoraConfigurationError, liblibLoraContext, liblibLoraModelId, parseLiblibLoras } from "./liblib-lora";
import { liblibStyleLoraModelId, resolveStyleExecutionPlan, type StyleProfileSnapshot } from "./style-profile";

// Quote the same defaults, explicit choices and automatic style assets as the
// admission path. Only model versions and user weights leave this boundary.
export function liblibLoraQuoteOptions(config: AiConfig, providerOptions?: Record<string, Record<string, unknown>>, style?: StyleProfileSnapshot | null) {
    const { profile, protocol, defaults } = liblibLoraContext(config);
    const explicit = providerOptions?.[LIBLIB_LORA_PROTOCOL]?.additionalNetwork;
    const configured = explicit !== undefined ? explicit : protocol === LIBLIB_LORA_PROTOCOL ? defaults.additionalNetwork : undefined;
    const selections = parseLiblibLoras(configured);
    const selected = new Set(selections.map((item) => item.modelId));
    if (style && protocol === LIBLIB_LORA_PROTOCOL) {
        const plan = resolveStyleExecutionPlan(style, { mode: "image", model: modelOptionName(config.model), interfaceType: protocol, loraProfile: profile });
        if (plan.status === "blocked") throw new Error(plan.warnings.join("；"));
        const native = new Set(plan.assets.filter((asset) => asset.action === "native" && asset.kind === "lora").map((asset) => asset.assetId));
        for (const asset of style.assets) {
            if (!native.has(asset.id)) continue;
            const modelId = liblibStyleLoraModelId(asset);
            const weight = asset.weight ?? profile?.models.find((model) => liblibLoraModelId(model.id) === modelId)?.defaultWeight;
            if (!selected.has(modelId)) { selections.push(...parseLiblibLoras([{ modelId, weight }])); selected.add(modelId); }
        }
    }
    const error = liblibLoraConfigurationError(selections, profile, protocol);
    if (error) throw new Error(error);
    if (configured === undefined && !selections.length) return undefined;
    return { [LIBLIB_LORA_PROTOCOL]: { additionalNetwork: selections } };
}
