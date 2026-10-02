import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { currentImageModerationReport, currentImageModerationSummary, imageModerationPresentation } from "@/lib/canvas/image-moderation";
import type { CanvasNodeData } from "@/types/canvas";

// The Go projection test verifies the complete serialized public response against this fixture.
const fixture = JSON.parse(readFileSync(new URL("../../backend/internal/canvas/testdata/image-moderation-share.json", import.meta.url), "utf8"));
function sharedNode(): CanvasNodeData {
    return structuredClone(fixture.project.nodes[0]);
}

describe("shared canvas moderation snapshot", () => {
    test("public response without private storage or check IDs displays the saved report", () => {
        const node = sharedNode();
        expect(node.metadata?.storageKey).toBeUndefined();
        expect(node.metadata?.imageModeration).toBeUndefined();
        const report = currentImageModerationSummary(node);
        expect(report?.summary).toBe("检测到内容风险，部分检测未完成");
        expect(report?.riskTags).toEqual([{ code: "violence", label: "暴力风险", level: "high" }]);
        expect(report).not.toHaveProperty("checkId");
        expect(imageModerationPresentation(report)).toEqual({ label: "高风险 · 未完成", tone: "error" });
        expect(currentImageModerationReport(node)).toBeUndefined();
    });

    test("rotating the share token preserves report identity", () => {
        const node = sharedNode();
        node.metadata!.content = "/api/public/canvas-shares/new-token/resources/resource_123/file";
        expect(currentImageModerationSummary(node)).toEqual(node.metadata!.sharedImageModeration!.report);
    });

    test.each([
        "/api/public/canvas-shares/share-token/resources/replacement/file",
        "/api/public/canvas-shares/share-token/resources/resource_123/thumbnail",
        "/api/public/canvas-shares/share-token/resources/resource_123%2Fother/file",
        "https://unrelated.example/api/public/canvas-shares/share-token/resources/resource_123/file",
        "data:image/png;base64,replacement",
        "",
    ])("does not attach the old report to changed or unsupported content: %s", (content) => {
        const node = sharedNode();
        node.metadata!.content = content;
        expect(currentImageModerationSummary(node)).toBeUndefined();
    });

    test("stale, pending, failed and partial snapshots never turn green", () => {
        const node = sharedNode();
        const report = node.metadata!.sharedImageModeration!.report;
        report.overallRisk = "none";
        report.riskTags = [];
        for (const status of ["queued", "running", "failed", "partial"] as const) {
            report.status = status;
            expect(imageModerationPresentation(currentImageModerationSummary(node)).tone).not.toBe("success");
        }
        report.status = "completed";
        report.isCurrent = false;
        expect(imageModerationPresentation(currentImageModerationSummary(node)).label).toBe("需要重新检测");
        report.isCurrent = true;
        expect(imageModerationPresentation(currentImageModerationSummary(node)).tone).toBe("success");
    });
});
