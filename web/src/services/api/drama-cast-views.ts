import { http } from "./request";
import type { DramaCastImageOptions, DramaTake } from "./drama";
import type { GenerationTask } from "./task-center";

export type CastViewDirection = "front" | "back" | "left" | "right" | "top" | "detail" | "custom";
export type CastViewImageOptions = Omit<DramaCastImageOptions, "subjectReferenceIds" | "styleReferenceIds"> & { subjectReferenceIds?: string[] | null; styleReferenceIds?: string[] | null };
export type CastViewConfig = { name: string; direction: CastViewDirection; prompt: string; imageOptions: CastViewImageOptions };
export type CastView = {
    id: string;
    projectId: string;
    castId: string;
    revision: number;
    config: CastViewConfig;
    taskId?: string;
    resourceId?: string;
    currentTakeId?: string;
    status: string;
    error?: string;
    takes: (DramaTake & { status: string; error?: string; current: boolean })[];
};
export type CastViewAction = { expectedRevision?: number; viewRevision?: number; confirmationToken?: string; clientOperationId?: string };
export type CastViewPreflight = { revision: number; viewRevision: number; ready: boolean; reason?: string; priced: boolean; estimated: boolean; amountMicrocredits: number; confirmationToken: string };

const path = (projectId: string, castId: string) => `/dramas/${encodeURIComponent(projectId)}/cast/${encodeURIComponent(castId)}/views`;
export const listDramaCastViews = (projectId: string, castId: string, signal?: AbortSignal) => http.get<{ views: CastView[] }>(path(projectId, castId), { signal });
export const saveDramaCastView = (projectId: string, castId: string, viewId: string | undefined, input: { expectedRevision: number; expectedCastRevision: number; viewRevision: number; config: CastViewConfig }) =>
    viewId ? http.put<CastView>(`${path(projectId, castId)}/${encodeURIComponent(viewId)}`, input) : http.post<CastView>(path(projectId, castId), input);
export const deleteDramaCastView = (projectId: string, castId: string, viewId: string, input: CastViewAction) => http.deleteWithBody<{ deleted: boolean }>(`${path(projectId, castId)}/${encodeURIComponent(viewId)}`, input);
export const preflightDramaCastView = (projectId: string, castId: string, viewId: string, input: CastViewAction) => http.post<CastViewPreflight>(`${path(projectId, castId)}/${encodeURIComponent(viewId)}/preflight`, input);
export const executeDramaCastView = (projectId: string, castId: string, viewId: string, input: CastViewAction) => http.post<GenerationTask>(`${path(projectId, castId)}/${encodeURIComponent(viewId)}/execute`, input);
export const adoptDramaCastView = (projectId: string, castId: string, viewId: string, input: { expectedRevision: number; viewRevision: number; takeId: string }) =>
    http.post<CastView>(`${path(projectId, castId)}/${encodeURIComponent(viewId)}/adopt`, input);
