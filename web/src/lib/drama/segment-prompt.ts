import type { DramaSegment } from "@/services/api/drama";

export function segmentPromptReferences(segment: DramaSegment) {
    return [...new Map([...(segment.promptSubjects ?? []), ...segment.request.references].map((ref) => [ref.castId ? `cast:${ref.castId}` : `image:${ref.resourceId}`, ref])).values()];
}

export function displaySegmentPrompt(segment: DramaSegment, prompt: string) {
    const names = new Map(
        segmentPromptReferences(segment)
            .filter((ref) => ref.castId)
            .map((ref) => [ref.castId, ref.name]),
    );
    return prompt.replace(/@\[segment-cast:([^\]\s]+)\]/g, (_, id: string) => (names.has(id) ? `@ ${names.get(id)}` : ""));
}

export function segmentSendPromptBody(segment: DramaSegment) {
    return (segment.request.resolvedPrompt ?? displaySegmentPrompt(segment, segment.videoPrompt)).trim();
}
