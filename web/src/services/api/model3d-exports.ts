import type { Model3DPreviewFormat, Model3DServerExportFormat } from "@/lib/model3d-formats";
import { http } from "@/services/api/request";
import { uploadTimeoutMs } from "@/services/api/resources";

export type Model3DExportResult = {
    resourceId: string;
    url: string;
    storageKey: string;
    format: Model3DServerExportFormat;
    fileName: string;
    mimeType: string;
    bytes: number;
};

export type Model3DExportTask = {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    stage: string;
    progress: number;
    error?: string;
    result?: Model3DExportResult;
};

export type Model3DExportRequest = {
    requestId: string;
    resourceId?: string;
    sourceFormat: Model3DPreviewFormat;
    fileName?: string;
    format: Model3DServerExportFormat;
    animation?: string;
    fps?: number;
};

export function getModel3DExportCapabilities(signal?: AbortSignal) {
    return http.get<{ available: boolean; formats: Model3DServerExportFormat[] }>("/model3d/exports/capabilities", { signal });
}

export function createModel3DExport(request: Model3DExportRequest, file?: Blob, signal?: AbortSignal) {
    if (!file) return http.post<Model3DExportTask>("/model3d/exports", request, { signal });
    const form = new FormData();
    for (const [key, value] of Object.entries(request)) if (value !== undefined) form.append(key, String(value));
    form.append("file", file, request.fileName || `model.${request.sourceFormat}`);
    return http.post<Model3DExportTask>("/model3d/exports", form, { signal, timeout: uploadTimeoutMs(file.size) });
}

export function getModel3DExport(id: string, signal?: AbortSignal) {
    return http.get<Model3DExportTask>(`/model3d/exports/${encodeURIComponent(id)}`, { signal });
}

export function cancelModel3DExport(id: string) {
    return http.delete<Model3DExportTask>(`/model3d/exports/${encodeURIComponent(id)}`);
}

export function cancelModel3DExportRequest(requestId: string) {
    return http.delete<Model3DExportTask>(`/model3d/exports/by-request/${encodeURIComponent(requestId)}`);
}
