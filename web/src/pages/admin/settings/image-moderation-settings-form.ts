import type { ModerationAdminState, ModerationProviderInput, ModerationProviderView } from "@/services/api/image-moderation";

export type ImageModerationProviderDraft = ModerationProviderInput & { accessKeyId: string; accessKeySecret: string };

export function moderationProviderDraft(provider: ModerationProviderView | null, state: ModerationAdminState): ImageModerationProviderDraft {
    const providerType = state.providerTypes.find((item) => item.type === provider?.type) || state.providerTypes[0];
    return {
        name: provider?.name || "",
        type: provider?.type || providerType?.type || "",
        enabled: provider?.enabled ?? true,
        region: provider?.region || providerType?.regions[0]?.value || "",
        services: provider ? [...provider.services] : providerType?.services[0] ? [providerType.services[0].code] : [],
        timeoutSeconds: provider?.timeoutSeconds ?? 30,
        maxCallsPerDay: provider?.maxCallsPerDay ?? 100,
        minIntervalSeconds: provider?.minIntervalSeconds ?? 10,
        accessKeyId: "",
        accessKeySecret: "",
    };
}

export function moderationProviderInput(draft: ImageModerationProviderDraft): ModerationProviderInput {
    const accessKeyId = draft.accessKeyId.trim();
    const accessKeySecret = draft.accessKeySecret.trim();
    return {
        name: draft.name.trim(),
        type: draft.type,
        enabled: draft.enabled,
        region: draft.region,
        services: [...new Set(draft.services)].sort(),
        timeoutSeconds: draft.timeoutSeconds,
        maxCallsPerDay: draft.maxCallsPerDay,
        minIntervalSeconds: draft.minIntervalSeconds,
        ...(accessKeyId ? { accessKeyId } : {}),
        ...(accessKeySecret ? { accessKeySecret } : {}),
    };
}

export function moderationProviderDraftChanged(draft: ImageModerationProviderDraft, provider: ModerationProviderView | null, state: ModerationAdminState): boolean {
    return JSON.stringify(moderationProviderInput(draft)) !== JSON.stringify(moderationProviderInput(moderationProviderDraft(provider, state)));
}

export function validateModerationProviderDraft(draft: ImageModerationProviderDraft, provider: ModerationProviderView | null, state: ModerationAdminState): string {
    const input = moderationProviderInput(draft);
    const providerType = state.providerTypes.find((item) => item.type === input.type);
    if (!input.name || Array.from(input.name).length > 120) return "Provider 名称需为 1–120 个字符";
    if (!providerType) return "请选择当前支持的检测平台";
    if (provider && input.type !== provider.type) return "已有 Provider 不可更换平台类型，请新建 Provider";
    if (!providerType.regions.some((region) => region.value === input.region)) return "请选择支持的服务地域";
    if (!input.services.length || input.services.some((service) => !providerType.services.some((item) => item.code === service))) return "请选择至少一个支持的检测项目";
    if (Boolean(input.accessKeyId) !== Boolean(input.accessKeySecret)) return "更换凭据时请同时填写 AccessKey ID 和 AccessKey Secret";
    if (!input.accessKeyId && (!provider?.accessKeyIdConfigured || !provider.accessKeySecretConfigured)) return "请填写 AccessKey ID 和 AccessKey Secret";
    if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 5 || input.timeoutSeconds > 120) return "单项检测超时需为 5–120 秒的整数";
    if (!Number.isInteger(input.maxCallsPerDay) || input.maxCallsPerDay < 1 || input.maxCallsPerDay > 100_000) return "每日调用上限需为 1–100000 次的整数";
    if (!Number.isInteger(input.minIntervalSeconds) || input.minIntervalSeconds < 1 || input.minIntervalSeconds > 3600) return "重复检测间隔需为 1–3600 秒的整数";
    return "";
}

export function moderationProviderStatus(provider: ModerationProviderView, state: Pick<ModerationAdminState, "activeProviderId" | "activeConfigId">): { label: string; tone: "neutral" | "warning" | "success" } {
    if (provider.archived) return { label: "已归档", tone: "neutral" };
    if (provider.id === state.activeProviderId) {
        return provider.configId === state.activeConfigId ? { label: "当前生效", tone: "success" } : { label: "新版本未应用", tone: "warning" };
    }
    return provider.enabled ? { label: "备用", tone: "neutral" } : { label: "已停用", tone: "neutral" };
}

export function moderationProviderResponseMatches(provider: ModerationProviderView, input: ModerationProviderInput, previous: ModerationProviderView | null): boolean {
    return Boolean(provider.id && provider.configId)
        && (!previous || (provider.id === previous.id && provider.configId !== previous.configId && provider.version > previous.version))
        && provider.name === input.name && provider.type === input.type && provider.enabled === input.enabled && !provider.archived
        && provider.region === input.region
        && JSON.stringify([...provider.services].sort()) === JSON.stringify([...input.services].sort())
        && provider.timeoutSeconds === input.timeoutSeconds && provider.maxCallsPerDay === input.maxCallsPerDay && provider.minIntervalSeconds === input.minIntervalSeconds
        && provider.accessKeyIdConfigured && provider.accessKeySecretConfigured;
}

export function isModerationAdminState(value: unknown): value is ModerationAdminState {
    if (!value || typeof value !== "object") return false;
    const state = value as ModerationAdminState;
    if (!Array.isArray(state.providers) || !Array.isArray(state.providerTypes)
        || typeof state.activeProviderId !== "string" || typeof state.activeConfigId !== "string"
        || Boolean(state.activeProviderId) !== Boolean(state.activeConfigId)
        || !Number.isInteger(state.policyRevision) || state.policyRevision < 0) return false;
    const providerIds = new Set<string>();
    for (const provider of state.providers) {
        if (!provider || !provider.id || typeof provider.id !== "string" || providerIds.has(provider.id)
            || typeof provider.name !== "string" || !provider.name || typeof provider.type !== "string"
            || typeof provider.enabled !== "boolean" || typeof provider.archived !== "boolean"
            || typeof provider.configId !== "string" || !provider.configId || !Number.isInteger(provider.version) || provider.version < 1
            || typeof provider.region !== "string" || !Array.isArray(provider.services) || !provider.services.every((service) => typeof service === "string")
            || !Number.isInteger(provider.timeoutSeconds) || provider.timeoutSeconds < 5 || provider.timeoutSeconds > 120
            || !Number.isInteger(provider.maxCallsPerDay) || provider.maxCallsPerDay < 1 || provider.maxCallsPerDay > 100_000
            || !Number.isInteger(provider.minIntervalSeconds) || provider.minIntervalSeconds < 1 || provider.minIntervalSeconds > 3600
            || typeof provider.accessKeyIdConfigured !== "boolean" || typeof provider.accessKeySecretConfigured !== "boolean") return false;
        providerIds.add(provider.id);
    }
    if (state.activeProviderId && !state.providers.some((provider) => provider.id === state.activeProviderId && !provider.archived)) return false;
    return state.providerTypes.every((providerType) => providerType && typeof providerType.type === "string" && typeof providerType.label === "string"
        && Array.isArray(providerType.services) && providerType.services.every((service) => service && typeof service.code === "string" && typeof service.label === "string")
        && Array.isArray(providerType.regions) && providerType.regions.every((region) => region && typeof region.value === "string" && typeof region.label === "string"));
}
