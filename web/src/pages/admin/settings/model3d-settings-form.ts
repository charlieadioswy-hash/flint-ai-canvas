import type { Model3DAdminState, Model3DProviderInput, Model3DProviderView } from "@/services/api/model3d";

export type Model3DProviderDraft = Model3DProviderInput & { apiKey: string };

export function model3DProviderDraft(provider: Model3DProviderView | null, state: Model3DAdminState): Model3DProviderDraft {
    const type = state.providerTypes.find((item) => item.type === provider?.type) || state.providerTypes[0];
    return {
        name: provider?.name || "",
        type: provider?.type || type?.type || "",
        enabled: provider?.enabled ?? true,
        defaultModel: provider?.defaultModel || type?.modelVersions[0]?.id || "",
        allowedModels: provider ? [...provider.allowedModels] : type?.modelVersions.map((item) => item.id) || [],
        allowedModes: provider ? [...provider.allowedModes] : [...(type?.modes || [])],
        timeoutSeconds: provider?.timeoutSeconds ?? 60,
        maxTasksPerDay: provider?.maxTasksPerDay ?? 100,
        apiKey: "",
    };
}

export function model3DProviderInput(draft: Model3DProviderDraft): Model3DProviderInput {
    return {
        name: draft.name.trim(), type: draft.type, enabled: draft.enabled,
        defaultModel: draft.defaultModel,
        allowedModels: [...new Set(draft.allowedModels)].sort(),
        allowedModes: [...new Set(draft.allowedModes)].sort(),
        timeoutSeconds: draft.timeoutSeconds, maxTasksPerDay: draft.maxTasksPerDay,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    };
}

export function model3DProviderDraftChanged(draft: Model3DProviderDraft, provider: Model3DProviderView | null, state: Model3DAdminState) {
    return JSON.stringify(model3DProviderInput(draft)) !== JSON.stringify(model3DProviderInput(model3DProviderDraft(provider, state)));
}

export function validateModel3DProviderDraft(draft: Model3DProviderDraft, provider: Model3DProviderView | null, state: Model3DAdminState): string {
    const input = model3DProviderInput(draft);
    const type = state.providerTypes.find((item) => item.type === input.type);
    if (!input.name || Array.from(input.name).length > 120) return "服务商名称需为 1–120 个字符";
    if (!type || (provider && input.type !== provider.type)) return "请选择支持的服务商类型；已有配置不可更换类型";
    if (!input.allowedModels.length || input.allowedModels.some((id) => !type.modelVersions.some((model) => model.id === id))) return "请至少开放一个支持的模型版本";
    if (!input.allowedModels.includes(input.defaultModel)) return "默认模型必须在开放的模型版本中";
    if (!input.allowedModes.length || input.allowedModes.some((mode) => !type.modes.includes(mode))) return "请至少开放一种支持的生成模式";
    if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 10 || input.timeoutSeconds > 120) return "请求超时需为 10–120 秒的整数";
    if (!Number.isInteger(input.maxTasksPerDay) || input.maxTasksPerDay < 1 || input.maxTasksPerDay > 100000) return "每日任务上限需为 1–100000 的整数";
    if (!input.apiKey && !provider?.apiKeyConfigured) return "请填写 API Key";
    return "";
}

export function model3DProviderStatus(provider: Model3DProviderView, state: Pick<Model3DAdminState, "activeProviderId" | "activeConfigId">): { label: string; tone: "neutral" | "warning" | "success" } {
    if (provider.archived) return { label: "已归档", tone: "neutral" };
    if (provider.id === state.activeProviderId) return provider.configId === state.activeConfigId ? { label: "当前生效", tone: "success" } : { label: "新版本未应用", tone: "warning" };
    return { label: provider.enabled ? "备用" : "已停用", tone: "neutral" };
}

export function model3DProviderResponseMatches(provider: Model3DProviderView, input: Model3DProviderInput, previous: Model3DProviderView | null) {
    return Boolean(provider?.id && provider.configId && provider.apiKeyConfigured && !provider.archived)
        && (!previous || (provider.id === previous.id && provider.configId !== previous.configId && provider.version > previous.version))
        && provider.name === input.name && provider.type === input.type && provider.enabled === input.enabled
        && provider.defaultModel === input.defaultModel
        && JSON.stringify([...provider.allowedModels].sort()) === JSON.stringify([...input.allowedModels].sort())
        && JSON.stringify([...provider.allowedModes].sort()) === JSON.stringify([...input.allowedModes].sort())
        && provider.timeoutSeconds === input.timeoutSeconds && provider.maxTasksPerDay === input.maxTasksPerDay;
}

export function isModel3DAdminState(value: unknown): value is Model3DAdminState {
    if (!value || typeof value !== "object") return false;
    const state = value as Model3DAdminState;
    if (!Array.isArray(state.providers) || !Array.isArray(state.providerTypes)
        || typeof state.activeProviderId !== "string" || typeof state.activeConfigId !== "string"
        || Boolean(state.activeProviderId) !== Boolean(state.activeConfigId)
        || !Number.isInteger(state.policyRevision) || state.policyRevision < 0) return false;
    const ids = new Set<string>();
    for (const row of state.providers) {
        if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id)
            || typeof row.configId !== "string" || !row.configId || !Number.isInteger(row.version) || row.version < 1
            || typeof row.name !== "string" || !row.name || typeof row.type !== "string"
            || typeof row.enabled !== "boolean" || typeof row.archived !== "boolean" || typeof row.apiKeyConfigured !== "boolean"
            || typeof row.defaultModel !== "string" || !Array.isArray(row.allowedModels) || !row.allowedModels.includes(row.defaultModel)
            || !row.allowedModels.every((model) => typeof model === "string" && Boolean(model))
            || !Array.isArray(row.allowedModes) || !row.allowedModes.length || !row.allowedModes.every((mode) => ["text", "image", "multiview"].includes(mode))
            || !Number.isInteger(row.timeoutSeconds) || row.timeoutSeconds < 10 || row.timeoutSeconds > 120
            || !Number.isInteger(row.maxTasksPerDay) || row.maxTasksPerDay < 1 || row.maxTasksPerDay > 100000) return false;
        ids.add(row.id);
    }
    if (state.activeProviderId && !state.providers.some((row) => row.id === state.activeProviderId && !row.archived)) return false;
    return state.providerTypes.every((type) => type && typeof type.type === "string" && typeof type.label === "string"
        && Array.isArray(type.modes) && type.modes.every((mode) => ["text", "image", "multiview"].includes(mode))
        && Array.isArray(type.modelVersions) && type.modelVersions.every((model) => model && typeof model.id === "string" && typeof model.label === "string"
            && typeof model.supportsAdvanced === "boolean" && Number.isFinite(model.maxFacesStandard) && Number.isFinite(model.maxFacesDetailed)));
}
