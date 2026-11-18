import { expect, test } from "bun:test";
import { splitMentionText } from "@/components/canvas/canvas-mention-editable";
import { displaySegmentPrompt, segmentSendPromptBody } from "@/lib/drama/segment-prompt";
import { segmentPromptEditorReferences } from "@/pages/projects/studio/segment-prompt-references";
import type { DramaSegment } from "@/services/api/drama";

test("段提示词显示资产名称，并区分同名资产和独立附图", () => {
    const segment = {
        promptSubjects: [{ castId: "cast-b", kind: "character", name: "秦子武", label: "", sent: false }],
        request: {
            references: [
                { castId: "cast-a", kind: "character", name: "秦子武", label: "参考图1", resourceId: "new-image", sent: true },
                { castId: "", kind: "image", name: "构图草稿", label: "参考图2", resourceId: "upload", sent: true },
            ],
        },
    } as DramaSegment;
    const prompt = "秦子武（@[segment-cast:cast-a]）推门，另一人（@[segment-cast:cast-b]）回头，构图用参考图2。";
    const rendered = splitMentionText(prompt, segmentPromptEditorReferences(segment, new Map())).flatMap((part) => (part.type === "mention" ? [[part.reference.label, part.reference.storageKey, part.token]] : []));
    expect(rendered).toEqual([
        ["秦子武", "resource:new-image", "@[segment-cast:cast-a]"],
        ["秦子武", undefined, "@[segment-cast:cast-b]"],
        ["参考图2", "resource:upload", "参考图2"],
    ]);
    expect(displaySegmentPrompt(segment, prompt)).toBe("秦子武（@ 秦子武）推门，另一人（@ 秦子武）回头，构图用参考图2。");
    const resolvedPrompt = "秦子武（参考图1）推门，另一人回头，构图用参考图2。";
    expect(segmentSendPromptBody({ ...segment, videoPrompt: prompt, request: { ...segment.request, resolvedPrompt } })).toBe(resolvedPrompt);
    expect(segmentSendPromptBody({ ...segment, videoPrompt: prompt })).not.toContain("segment-cast:");
});
