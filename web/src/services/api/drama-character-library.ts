import type { DramaCast } from "./drama";
import type { ProjectCharacterDetail } from "./projects";
import { http } from "./request";

export type ImportDramaCharacterLibraryInput = {
    expectedRevision: number;
    libraryAssetId: string;
    libraryVersionId: string;
    targetCastId?: string;
    expectedCastRevision?: number;
    replaceText: boolean;
    representationId?: string;
    includeVoice: boolean;
};

const castBase = (projectId: string, castId: string) => `/dramas/${encodeURIComponent(projectId)}/cast/${encodeURIComponent(castId)}`;

export function importDramaCharacterLibrary(projectId: string, input: ImportDramaCharacterLibraryInput) {
    return http.post<{ cast: DramaCast }>(`/dramas/${encodeURIComponent(projectId)}/cast/character-library/import`, input);
}

export function saveDramaCharacterLibrary(projectId: string, castId: string, input: { expectedRevision: number; expectedCastRevision: number; name: string }) {
    return http.post<ProjectCharacterDetail>(`${castBase(projectId, castId)}/character-library/save`, input);
}

export function updateDramaCharacterDefinition(projectId: string, castId: string, input: { expectedRevision: number; expectedCastRevision: number; fields: Record<string, string> }) {
    return http.patch<{ cast: DramaCast }>(`${castBase(projectId, castId)}/definition`, input);
}

export type DramaCharacterUsage = {
    hasStory: boolean;
    appearances: Array<{ episodeId: string; episodeNumber: number; episodeTitle: string; shotId: string; position: number; segmentIndex: number }>;
    audioReferences: Array<{ episodeId: string; episodeNumber: number; segmentId: string; segmentIndex: number }>;
    imageReferences: Array<{ episodeId: string; episodeNumber: number; segmentId: string; segmentIndex: number }>;
};

export function getDramaCharacterUsage(projectId: string, castId: string, signal?: AbortSignal) {
    return http.get<DramaCharacterUsage>(`${castBase(projectId, castId)}/usage`, { signal });
}
