import type { DramaModelChoice } from "./drama";
import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type DramaShotMediaKind = "image" | "video" | "audio";

export type DramaShotMediaConfig = {
    model: DramaModelChoice;
    prompt: string;
    operation: "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video" | "reference_to_video" | "audio";
    aspectRatio: string;
    resolution: string;
    seconds?: number;
    generateAudio: boolean;
    referenceResourceIds: string[];
    firstFrameResourceId?: string;
    lastFrameResourceId?: string;
    audioVoice?: string;
    audioInstructions?: string;
};

export type DramaShotMediaTake = {
    id: string;
    projectId: string;
    ownerId: string;
    kind: "shot_image" | "shot_video" | "shot_audio";
    version: number;
    resourceId: string;
    taskId: string;
    prompt: string;
    durationMs: number;
    createdAt: string;
    status: string;
    current: boolean;
    error?: string;
};

export type DramaShotMedia = {
    id: string;
    projectId: string;
    episodeId: string;
    shotId: string;
    kind: DramaShotMediaKind;
    revision: number;
    currentTakeId?: string;
    pendingTakeId?: string;
    taskId?: string;
    resourceId?: string;
    status: string;
    config: DramaShotMediaConfig;
    takes: DramaShotMediaTake[];
    error?: string;
};

export type DramaShotMediaPreflight = {
    shotId: string;
    kind: DramaShotMediaKind;
    revision: number;
    baseRevision: number;
    ready: boolean;
    reason?: string;
    amountMicrocredits: number;
    priced: boolean;
    estimated: boolean;
    confirmationToken: string;
    config: DramaShotMediaConfig;
};

export type DramaShotMediaAction = {
    expectedRevision?: number;
    baseRevision?: number;
    confirmationToken?: string;
    clientOperationId?: string;
};

function mediaPath(projectId: string, shotId: string, kind: DramaShotMediaKind) {
    return `/dramas/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/media/${kind}`;
}

export function getDramaShotMedia(projectId: string, shotId: string, kind: DramaShotMediaKind, signal?: AbortSignal) {
    return http.get<DramaShotMedia>(mediaPath(projectId, shotId, kind), { signal });
}

export function saveDramaShotMedia(projectId: string, shotId: string, kind: DramaShotMediaKind, input: { expectedRevision: number; config: DramaShotMediaConfig }) {
    return http.put<DramaShotMedia>(mediaPath(projectId, shotId, kind), input);
}

export function preflightDramaShotMedia(projectId: string, shotId: string, kind: DramaShotMediaKind, input: DramaShotMediaAction) {
    return http.post<DramaShotMediaPreflight>(`${mediaPath(projectId, shotId, kind)}/preflight`, input);
}

export function executeDramaShotMedia(projectId: string, shotId: string, kind: DramaShotMediaKind, input: DramaShotMediaAction) {
    return http.post<GenerationTask>(`${mediaPath(projectId, shotId, kind)}/execute`, input);
}

export function adoptDramaShotMedia(projectId: string, shotId: string, kind: DramaShotMediaKind, input: { expectedRevision: number; takeId: string }) {
    return http.post<DramaShotMedia>(`${mediaPath(projectId, shotId, kind)}/adopt`, input);
}
