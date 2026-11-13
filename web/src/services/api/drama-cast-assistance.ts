import type { DramaModelChoice, DramaSummary } from "./drama";
import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type DramaCastAssistancePurpose = "voice_sample" | "fill_description" | "image_prompt";
export type DramaCastAssistanceRequest = {
    purpose: DramaCastAssistancePurpose;
    expectedRevision: number;
    castRevision: number;
    model: DramaModelChoice;
    instruction: string;
    sampleText: string;
    voiceKey: string;
    sourceResourceId: string;
    confirmationToken?: string;
    clientOperationId?: string;
};
export type DramaCastAssistancePreflight = {
    ready: boolean;
    reason?: string;
    amountMicrocredits: number;
    priced: boolean;
    estimated: boolean;
    confirmationToken: string;
};
export type DramaCastAssistanceResult = {
    id: string;
    taskId: string;
    purpose: DramaCastAssistancePurpose;
    version: number;
    status: string;
    progress: number;
    text?: string;
    resourceId?: string;
    error?: string;
    sourceRevision: number;
    stale: boolean;
    createdAt: string;
};

function path(projectId: string, castId: string) {
    return `/dramas/${encodeURIComponent(projectId)}/cast/${encodeURIComponent(castId)}/assistance`;
}
export function getDramaCastAssistance(projectId: string, castId: string, signal?: AbortSignal) {
    return http.get<DramaCastAssistanceResult[]>(path(projectId, castId), { signal });
}
export function preflightDramaCastAssistance(projectId: string, castId: string, input: DramaCastAssistanceRequest) {
    return http.post<DramaCastAssistancePreflight>(`${path(projectId, castId)}/preflight`, input);
}
export function executeDramaCastAssistance(projectId: string, castId: string, input: DramaCastAssistanceRequest) {
    return http.post<GenerationTask>(`${path(projectId, castId)}/execute`, input);
}
export function adoptDramaCastAssistance(projectId: string, castId: string, input: { expectedRevision: number; castRevision: number; takeId: string; text?: string }) {
    return http.post<DramaSummary>(`${path(projectId, castId)}/adopt`, input);
}
