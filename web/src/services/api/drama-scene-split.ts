import { http } from "./request";
import type { DramaModelChoice, DramaSummary } from "./drama";

export type DramaSceneSplitRequest = {
    expectedRevision: number;
    episodeRevision: number;
    shotIds: string[];
    targetShotCount: number;
    directorTemplate: string;
    instruction: string;
    model: DramaModelChoice;
    confirmationToken?: string;
    clientOperationId?: string;
};

export type DramaSceneSplitPreflight = { ready: boolean; reason?: string; amountMicrocredits: number; priced: boolean; estimated: boolean; confirmationToken: string };
export type DramaSceneSplitResult = {
    takeId: string;
    taskId: string;
    shotIds: string[];
    status: string;
    progress: number;
    text?: string;
    error?: string;
    stale: boolean;
    applied: boolean;
    snapshot?: { shotsJson: string; segmentsJson: string; mediaJson: string; takesJson: string; newShotIdsJson: string; createdAt: string };
};

const path = (projectId: string, episodeId: string) => `/dramas/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/scene-splits`;
export const getDramaSceneSplits = (projectId: string, episodeId: string, signal?: AbortSignal) => http.get<DramaSceneSplitResult[]>(path(projectId, episodeId), { signal });
export const preflightDramaSceneSplit = (projectId: string, episodeId: string, input: DramaSceneSplitRequest) => http.post<DramaSceneSplitPreflight>(`${path(projectId, episodeId)}/preflight`, input);
export const executeDramaSceneSplit = (projectId: string, episodeId: string, input: DramaSceneSplitRequest) => http.post<{ id: string }>(`${path(projectId, episodeId)}/execute`, input);
export const adoptDramaSceneSplit = (projectId: string, episodeId: string, input: { expectedRevision: number; episodeRevision: number; takeId: string }) => http.post<DramaSummary>(`${path(projectId, episodeId)}/adopt`, input);
