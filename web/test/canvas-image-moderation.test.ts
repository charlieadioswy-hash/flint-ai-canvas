import { describe, expect, test } from "bun:test";

import { currentImageModerationReport, imageModerationPresentation, imageModerationSourceIdentity, isImageModerationPending } from "@/lib/canvas/image-moderation";
import { resolveNodeToolbarPlacement, resolveToolbarTools, type ToolContext, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import type { ModerationReport } from "@/services/api/image-moderation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function report(patch: Partial<ModerationReport> = {}): ModerationReport {
    return { checkId: "check", resourceId: "original", contentVersion: "version", status: "completed", overallRisk: "none", riskTags: [], summary: "未检测到内容风险", createdAt: "2026-10-01T00:00:00Z", isCurrent: true, ...patch };
}
function node(content = "image", storageKey = "resource:original"): CanvasNodeData {
    return { id: "node", type: CanvasNodeType.Image, title: "图片", width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { content, storageKey } };
}

describe("image moderation report identity and result", () => {
    test("only a completed, current, no-risk report is green", () => {
        expect(imageModerationPresentation(report()).tone).toBe("success");
        for (const status of ["queued", "running", "partial", "failed"] as const) expect(imageModerationPresentation(report({ status })).tone).not.toBe("success");
        expect(imageModerationPresentation(report({ overallRisk: "unknown" })).tone).not.toBe("success");
        expect(imageModerationPresentation(report({ isCurrent: false })).label).toBe("需要重新检测");
    });
    test("partial reports preserve confirmed risk while making incompleteness explicit", () => {
        expect(imageModerationPresentation(report({ status: "partial", overallRisk: "high" }))).toEqual({ label: "高风险 · 未完成", tone: "error" });
        expect(imageModerationPresentation(report({ status: "partial", overallRisk: "medium" })).label).toContain("未完成");
        expect(imageModerationPresentation(report({ status: "partial", overallRisk: "none" })).label).toBe("检测未完成");
        expect(imageModerationPresentation(report({ status: "failed", overallRisk: "high" })).label).toBe("检测失败");
    });
    test("signed display URLs, titles, position and previews do not change original-resource identity", () => {
        const original = node("https://cdn/image?signature=first");
        original.metadata!.imageModeration = { sourceIdentity: imageModerationSourceIdentity(original), report: report() };
        const changed = { ...original, title: "新标题", position: { x: 20, y: 30 }, metadata: { ...original.metadata, content: "https://cdn/image?signature=second", previewContent: "thumbnail" } };
        expect(currentImageModerationReport(changed)?.checkId).toBe("check");
        changed.metadata.storageKey = "resource:replacement";
        expect(currentImageModerationReport(changed)).toBeUndefined();
    });
    test("inline source identity stores only a fingerprint and changes when original content changes", () => {
        const source = node("data:image/png;base64,secret-image", "");
        const identity = imageModerationSourceIdentity(source);
        expect(identity).not.toContain("secret-image");
        source.metadata!.imageModeration = { sourceIdentity: identity, report: report() };
        source.metadata!.content = "data:image/png;base64,new-image";
        expect(currentImageModerationReport(source)).toBeUndefined();
    });
    test("only queued and running reports poll", () => {
        expect(isImageModerationPending(report({ status: "queued" }))).toBe(true);
        expect(isImageModerationPending(report({ status: "running" }))).toBe(true);
        for (const status of ["completed", "partial", "failed"] as const) expect(isImageModerationPending(report({ status }))).toBe(false);
    });
});

describe("manual image moderation entry", () => {
    for (const workspaceMode of ["professional", "simple"] as const) {
        test(`${workspaceMode} keeps moderation first and never invokes a handler during rendering`, () => {
            const source = node();
            let calls = 0;
            const context: ToolContext = {
                selectedCount: 0,
                selectedNodeTypes: new Set(),
                selectedVideoCount: 0,
                canvasTool: "move",
                workspaceMode,
                isProjectLinked: false,
                canUndo: false,
                canRedo: false,
                node: source,
                nodeMetadata: source.metadata,
                extractingVideoFrames: false,
                extractingAudio: false,
                trimmingVideo: false,
                mergingVideos: false,
                addPanelOpen: false,
                appearancePanelOpen: false,
                settingsPanelOpen: false,
                handlers: {
                    onNodeImageModeration: (received: CanvasNodeData) => {
                        expect(received).toBe(source);
                        calls++;
                    },
                } as ToolbarHandlers,
            };
            const primary = resolveToolbarTools("node-hover", context, null)
                .filter((tool) => resolveNodeToolbarPlacement(tool, context).group === "primary")
                .sort((a, b) => resolveNodeToolbarPlacement(a, context).order - resolveNodeToolbarPlacement(b, context).order);
            expect(primary[0].id).toBe("image-moderation");
            expect(calls).toBe(0);
            primary[0].run(context);
            expect(calls).toBe(1);
            context.nodeMetadata = {};
            expect(resolveToolbarTools("node-hover", context, null).some((tool) => tool.id === "image-moderation")).toBe(false);
        });
    }
});
