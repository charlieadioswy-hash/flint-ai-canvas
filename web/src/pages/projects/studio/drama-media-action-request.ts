import type { DramaModelChoice, DramaSegment, DramaStudioActionRequest } from "@/services/api/drama";

export type DramaMediaActionTarget = DramaStudioActionRequest & { episodeNumber?: number; segmentTitle?: string };

export function dramaMediaActionKey(request: DramaMediaActionTarget) {
    return JSON.stringify([
        request.action,
        request.targetId,
        request.episodeId || "",
        request.baseRevision ?? null,
        request.targetRevision ?? null,
        request.videoModel?.logicalModelId || "",
        request.videoModel?.channelId || "",
        request.videoModel?.modelKey || "",
    ]);
}

export function dramaVideoAction(episode: { id: string; number: number }, segment: DramaSegment, videoModel?: DramaModelChoice): DramaMediaActionTarget {
    return { action: "segment_video", targetId: segment.id, episodeId: episode.id, episodeNumber: episode.number, segmentTitle: segment.title, targetRevision: segment.revision, ...(videoModel ? { videoModel } : {}) };
}

export function dramaCastImageAction(cast: { id: string; name?: string }, episodeId?: string): DramaMediaActionTarget {
    return { action: "cast_image", targetId: cast.id, segmentTitle: cast.name, ...(episodeId ? { episodeId } : {}) };
}
