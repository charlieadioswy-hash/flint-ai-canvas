import { http } from "@/services/api/request";

export type ModerationRisk = "none" | "low" | "medium" | "high" | "unknown";
export type ModerationStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type ModerationRiskTag = { code: string; label: string; level: ModerationRisk };
export type ModerationReportSummary = {
    status: ModerationStatus;
    overallRisk: ModerationRisk;
    riskTags: ModerationRiskTag[];
    summary: string;
    createdAt: string;
    completedAt?: string;
    isCurrent: boolean;
};
export type ModerationReport = ModerationReportSummary & {
    checkId: string;
    resourceId: string;
    contentVersion: string;
    reused?: boolean;
};

export type ModerationProviderView = {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    archived: boolean;
    configId: string;
    version: number;
    region: string;
    services: string[];
    timeoutSeconds: number;
    maxCallsPerDay: number;
    minIntervalSeconds: number;
    accessKeyIdConfigured: boolean;
    accessKeySecretConfigured: boolean;
};
export type ModerationProviderType = {
    type: string;
    label: string;
    services: Array<{ code: string; label: string }>;
    regions: Array<{ value: string; label: string }>;
};
export type ModerationAdminState = {
    providers: ModerationProviderView[];
    activeProviderId: string;
    activeConfigId: string;
    policyRevision: number;
    providerTypes: ModerationProviderType[];
};
export type ModerationProviderInput = {
    name: string;
    type: string;
    enabled: boolean;
    region: string;
    services: string[];
    timeoutSeconds: number;
    maxCallsPerDay: number;
    minIntervalSeconds: number;
    accessKeyId?: string;
    accessKeySecret?: string;
};

export function getImageModerationAvailability(signal?: AbortSignal) {
    return http.get<{ available: boolean }>("/image-moderation/availability", { signal });
}

export function createImageModerationCheck(resourceId: string, signal?: AbortSignal) {
    return http.post<ModerationReport>(`/resources/${encodeURIComponent(resourceId)}/moderation-checks`, {}, { signal });
}

export function getImageModerationCheck(checkId: string, signal?: AbortSignal) {
    return http.get<ModerationReport>(`/moderation-checks/${encodeURIComponent(checkId)}`, { signal });
}

export function getLatestImageModerationCheck(resourceId: string, signal?: AbortSignal) {
    return http.get<ModerationReport | null>(`/resources/${encodeURIComponent(resourceId)}/moderation-checks/latest`, { signal });
}

export function getModerationAdminState(signal?: AbortSignal) {
    return http.get<ModerationAdminState>("/admin/image-moderation", { signal });
}

export function saveModerationProvider(input: ModerationProviderInput, providerId?: string) {
    return providerId ? http.put<ModerationProviderView>(`/admin/image-moderation/providers/${encodeURIComponent(providerId)}`, input) : http.post<ModerationProviderView>("/admin/image-moderation/providers", input);
}

export function activateModerationProvider(providerId: string, configId: string, expectedRevision: number) {
    return http.post<ModerationAdminState>(`/admin/image-moderation/providers/${encodeURIComponent(providerId)}/activate`, { configId, expectedRevision });
}

export function disableImageModeration(expectedRevision: number) {
    return http.post<ModerationAdminState>("/admin/image-moderation/disable", { expectedRevision });
}

export function archiveModerationProvider(providerId: string) {
    return http.delete<ModerationAdminState>(`/admin/image-moderation/providers/${encodeURIComponent(providerId)}`);
}

export function validateModerationProvider(providerId: string, configId: string) {
    return http.post<{ valid: boolean; message: string }>(`/admin/image-moderation/providers/${encodeURIComponent(providerId)}/validate`, { configId });
}
