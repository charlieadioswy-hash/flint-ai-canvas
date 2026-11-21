import type { DramaShotMedia, DramaShotMediaAction, DramaShotMediaConfig } from "./drama-shot-media";
import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type DramaStoryboardCell = {
    id: string;
    projectId: string;
    boardId: string;
    index: number;
    row: number;
    column: number;
    shotId?: string;
    parentResourceId: string;
    resourceId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    mediaRevision: number;
    current: boolean;
};

export type DramaStoryboard = {
    id: string;
    projectId: string;
    episodeId: string;
    rows: number;
    columns: number;
    revision: number;
    taskId?: string;
    resourceId?: string;
    status: string;
    sourceWidth: number;
    sourceHeight: number;
    createdAt: string;
    config: DramaShotMediaConfig;
    shotIds: string[];
    cells: DramaStoryboardCell[];
    error?: string;
};

export type DramaStoryboardCreate = { clientOperationId: string; shotIds: string[]; rows: number; columns: number; config: DramaShotMediaConfig };
export type DramaStoryboardPreflight = { boardId: string; revision: number; baseRevision: number; ready: boolean; reason?: string; priced: boolean; amountMicrocredits: number; estimated: boolean; confirmationToken: string; scopeHash: string };

const boardsPath = (projectId: string) => `/dramas/${encodeURIComponent(projectId)}/storyboards`;
const boardPath = (projectId: string, boardId: string) => `${boardsPath(projectId)}/${encodeURIComponent(boardId)}`;

export function listDramaStoryboards(projectId: string, episodeId: string, shotIds: string[], signal?: AbortSignal) {
    return http.get<DramaStoryboard[]>(`/dramas/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/storyboards`, { params: { shotIds: shotIds.join(",") }, signal });
}
export function createDramaStoryboard(projectId: string, input: DramaStoryboardCreate) {
    return http.post<DramaStoryboard>(boardsPath(projectId), input);
}
export function quoteDramaStoryboard(projectId: string, input: Omit<DramaStoryboardCreate, "clientOperationId">, signal?: AbortSignal) {
    return http.post<DramaStoryboardPreflight>(`${boardsPath(projectId)}/quote`, input, { signal });
}
export function getDramaStoryboard(projectId: string, boardId: string, signal?: AbortSignal) {
    return http.get<DramaStoryboard>(boardPath(projectId, boardId), { signal });
}
export function preflightDramaStoryboard(projectId: string, boardId: string, input: DramaShotMediaAction) {
    return http.post<DramaStoryboardPreflight>(`${boardPath(projectId, boardId)}/preflight`, input);
}
export function executeDramaStoryboard(projectId: string, boardId: string, input: DramaShotMediaAction) {
    return http.post<GenerationTask>(`${boardPath(projectId, boardId)}/execute`, input);
}
export function splitDramaStoryboard(projectId: string, boardId: string, input: { expectedRevision: number }) {
    return http.post<DramaStoryboard>(`${boardPath(projectId, boardId)}/split`, input);
}
export function adoptDramaStoryboardCell(projectId: string, boardId: string, input: { expectedRevision: number; expectedMediaRevision: number; cellId: string }) {
    return http.post<DramaShotMedia>(`${boardPath(projectId, boardId)}/adopt`, input);
}
