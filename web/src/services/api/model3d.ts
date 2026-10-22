import { compactApiParams, http } from "@/services/api/request";

export type Model3DMode = "text" | "image" | "multiview";
export type Model3DView = "front" | "left" | "back" | "right";
export type Model3DParameters = {
    model: string;
    negativePrompt?: string;
    texture: boolean;
    pbr: boolean;
    faceLimit?: number;
    modelSeed?: number;
    imageSeed?: number;
    textureSeed?: number;
    textureQuality?: "standard" | "detailed" | "extreme" | "fast";
    textureVersion?: string;
    geometryQuality?: "standard" | "detailed";
    autoSize?: boolean;
    quad?: boolean;
    smartLowPoly?: boolean;
    compress?: "" | "geometry";
    exportOrientation?: "+x" | "-x" | "+y" | "-y";
    exportUv?: boolean;
    delight?: boolean;
    enableImageAutofix?: boolean;
    textureAlignment?: "original_image" | "geometry";
    orientation?: "default" | "align_image";
};

export type Model3DModelVersion = {
    id: string;
    label: string;
    supportsAdvanced: boolean;
    maxFacesStandard: number;
    maxFacesDetailed: number;
};

export type Model3DCapabilities = {
    available: boolean;
    providerName: string;
    policyRevision: number;
    activeConfigVersion: number;
    defaultModel: string;
    modelVersions: Model3DModelVersion[];
    modes: Model3DMode[];
    inputLimits: { maxBytes: number; mimeTypes: string[]; minViews: number; maxViews: number; requiredView: Model3DView; minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number };
};

export type Model3DCreateRequest = {
    requestId: string;
    sourceFingerprint: string;
    scope?: "canvas" | "standalone";
    canvasId?: string;
    nodeId?: string;
    groupId?: string;
    candidateIndex?: number;
    candidateCount?: number;
    mode: Model3DMode;
    prompt?: string;
    imageResourceId?: string;
    views?: { front: string; left?: string; back?: string; right?: string };
    parameters: Model3DParameters;
    expectedPolicyRevision: number;
};

export type Model3DResult = {
    assetId: string;
    resourceId: string;
    storageKey: string;
    url: string;
    fileName: string;
    mimeType: string;
    bytes: number;
    format: "glb" | "fbx";
};

export type Model3DTaskView = {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    stage: string;
    progress?: number;
    providerProgress?: number;
    mode: Model3DMode;
    scope?: "canvas" | "standalone";
    requestId?: string;
    prompt?: string;
    parameters?: Model3DParameters;
    imageResourceId?: string;
    views?: { front: string; left?: string; back?: string; right?: string };
    groupId?: string;
    candidateIndex?: number;
    candidateCount?: number;
    sourceFingerprint: string;
    clientContext: { canvasId: string; nodeId: string };
    submissionOutcome: "not_submitted" | "submitted" | "unknown";
    canRetryStorage: boolean;
    result?: Model3DResult;
    error?: { code: string; reason: string; message: string; retryClass: string };
    createdAt: string;
    updatedAt: string;
};

export type Model3DProviderInput = {
    name: string;
    type: string;
    baseUrl: string;
    enabled: boolean;
    defaultModel: string;
    allowedModels: string[];
    allowedModes: Model3DMode[];
    timeoutSeconds: number;
    maxTasksPerDay: number;
    apiKey?: string;
};

export type Model3DProviderView = Omit<Model3DProviderInput, "apiKey"> & {
    id: string;
    archived: boolean;
    configId: string;
    version: number;
    apiKeyConfigured: boolean;
};

export type Model3DAdminState = {
    providers: Model3DProviderView[];
    activeProviderId: string;
    activeConfigId: string;
    policyRevision: number;
    providerTypes: Array<{ type: string; label: string; modelVersions: Model3DModelVersion[]; modes: Model3DMode[] }>;
};

export function getModel3DCapabilities(signal?: AbortSignal) {
    return http.get<Model3DCapabilities>("/model3d/capabilities", { signal });
}

export function createModel3DTask(input: Model3DCreateRequest, signal?: AbortSignal) {
    return http.post<Model3DTaskView>("/model3d/tasks", input, { signal });
}

export function getModel3DTask(id: string, signal?: AbortSignal) {
    return http.get<Model3DTaskView>(`/model3d/tasks/${encodeURIComponent(id)}`, { signal });
}

export function getModel3DTaskByRequest(requestId: string, signal?: AbortSignal) {
    return http.get<Model3DTaskView | null>(`/model3d/requests/${encodeURIComponent(requestId)}`, { signal });
}

export type Model3DTaskList = { tasks: Model3DTaskView[]; nextCursor?: string };

export function listModel3DTasks(input: { scope?: "canvas" | "standalone"; limit?: number; cursor?: string; activeOnly?: boolean } = {}, signal?: AbortSignal) {
    const { activeOnly, ...params } = input;
    return http.get<Model3DTaskList>("/model3d/tasks", { params: compactApiParams({ ...params, ...(activeOnly ? { activeOnly: "true" } : {}) }), signal });
}

export function recoverModel3DTask(id: string, signal?: AbortSignal) {
    return http.post<Model3DTaskView>(`/model3d/tasks/${encodeURIComponent(id)}/recover`, {}, { signal });
}

export function getModel3DAdminState(signal?: AbortSignal) {
    return http.get<Model3DAdminState>("/admin/model3d", { signal });
}

export function saveModel3DProvider(input: Model3DProviderInput, providerId?: string) {
    return providerId ? http.put<Model3DProviderView>(`/admin/model3d/providers/${encodeURIComponent(providerId)}`, input) : http.post<Model3DProviderView>("/admin/model3d/providers", input);
}

export function activateModel3DProvider(providerId: string, configId: string, expectedRevision: number) {
    return http.post<Model3DAdminState>(`/admin/model3d/providers/${encodeURIComponent(providerId)}/activate`, { configId, expectedRevision });
}

export function disableModel3D(expectedRevision: number) {
    return http.post<Model3DAdminState>("/admin/model3d/disable", { expectedRevision });
}

export function archiveModel3DProvider(providerId: string) {
    return http.delete<Model3DAdminState>(`/admin/model3d/providers/${encodeURIComponent(providerId)}`);
}
