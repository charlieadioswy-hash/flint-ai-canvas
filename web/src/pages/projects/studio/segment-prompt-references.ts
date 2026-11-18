import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { DRAMA_CAST_KIND_LABEL } from "@/lib/drama/drama-format";
import { segmentPromptReferences } from "@/lib/drama/segment-prompt";
import type { DramaCast, DramaSegment, DramaSegmentReference } from "@/services/api/drama";

export function segmentPromptMention(ref: DramaSegmentReference) {
    return ref.castId ? `@[segment-cast:${ref.castId}]` : ref.label;
}

export function segmentPromptEditorReferences(segment: DramaSegment, castById: Map<string, DramaCast>): CanvasResourceReference[] {
    return segmentPromptReferences(segment).map((ref) => {
        const resourceId = ref.resourceId || castById.get(ref.castId)?.imageResourceId;
        return {
            id: `drama-ref:${segmentPromptMention(ref)}`,
            nodeId: "",
            kind: ref.kind === "character" ? "character" : "image",
            label: ref.castId ? ref.name : ref.label,
            title: `${ref.name} · ${DRAMA_CAST_KIND_LABEL[ref.kind]}${ref.sent ? "" : "（未附图）"}`,
            storageKey: resourceId ? `resource:${resourceId}` : undefined,
            mentionToken: segmentPromptMention(ref),
            active: true,
        };
    });
}
