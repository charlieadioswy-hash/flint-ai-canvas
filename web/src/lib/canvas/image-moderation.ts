import type { ModerationReport, ModerationReportSummary } from "@/services/api/image-moderation";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasImageModerationState = {
    sourceIdentity: string;
    report: ModerationReport;
};

export type CanvasSharedImageModerationState = {
    sourceIdentity: string;
    report: ModerationReportSummary;
};

// 原图存储键是稳定身份，签名展示地址和缩略图地址都不参与报告归属。
export function imageModerationSourceIdentity(node: CanvasNodeData) {
    const key = node.metadata?.storageKey;
    if (key) return key;
    const content = node.metadata?.content || "";
    if (!content) return "";
    let a = 2166136261;
    let b = 5381;
    for (let index = 0; index < content.length; index++) {
        a = Math.imul(a ^ content.charCodeAt(index), 16777619);
        b = Math.imul(b, 33) ^ content.charCodeAt(index);
    }
    return `inline:${content.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

export function currentImageModerationReport(node: CanvasNodeData) {
    const state = node.metadata?.imageModeration;
    return state?.sourceIdentity === imageModerationSourceIdentity(node) ? state.report : undefined;
}

export function currentImageModerationSummary(node: CanvasNodeData): ModerationReportSummary | undefined {
    const shared = node.metadata?.sharedImageModeration;
    if (!shared) return currentImageModerationReport(node);
    // 分享链接可轮换，报告仍绑定原图资源；换图后不能复用旧结论。
    const match = /^\/api\/public\/canvas-shares\/[^/?#]+\/resources\/([a-zA-Z0-9_-]{1,80})\/file(?:[?#].*)?$/.exec(node.metadata?.content || "");
    return match && shared.sourceIdentity === `resource:${match[1]}` ? shared.report : undefined;
}

export function isImageModerationPending(report?: ModerationReportSummary | null) {
    return report?.status === "queued" || report?.status === "running";
}

export function imageModerationPresentation(report?: ModerationReportSummary | null) {
    if (!report) return { label: "未检测", tone: "muted" as const };
    if (!report.isCurrent) return { label: "需要重新检测", tone: "warning" as const };
    if (report.status === "queued") return { label: "排队中", tone: "muted" as const };
    if (report.status === "running") return { label: "检测中", tone: "muted" as const };
    if (report.status === "failed") return { label: "检测失败", tone: "warning" as const };
    if (report.overallRisk === "high") return { label: report.status === "partial" ? "高风险 · 未完成" : "检测到高风险", tone: "error" as const };
    if (report.overallRisk === "medium") return { label: report.status === "partial" ? "建议复核 · 未完成" : "建议人工复核", tone: "warning" as const };
    if (report.overallRisk === "low") return { label: report.status === "partial" ? "低风险 · 未完成" : "低风险提示", tone: "warning" as const };
    if (report.status === "partial" || report.overallRisk === "unknown") return { label: "检测未完成", tone: "warning" as const };
    return { label: "未检测到风险", tone: "success" as const };
}

export function imageModerationTone(tone: ReturnType<typeof imageModerationPresentation>["tone"]) {
    return tone === "muted" ? "var(--muted-foreground)" : `var(--status-${tone})`;
}
