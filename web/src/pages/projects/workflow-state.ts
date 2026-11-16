import type { DramaEpisodeRow, DramaGuideStep, DramaSummary } from "@/services/api/drama";

/** 简易制作台的浏览步骤。与服务端 GuideStep 分开：回看不改后端阶段。 */
export type WorkflowStep = "source" | "review" | "style" | "assets" | "story" | "preview";

export const WORKFLOW_STEPS: ReadonlyArray<{ key: WorkflowStep; title: string }> = [
    { key: "source", title: "上传剧本" },
    { key: "review", title: "剧本格式" },
    { key: "style", title: "风格设置" },
    { key: "assets", title: "角色场景" },
    { key: "story", title: "漫剧分镜" },
    { key: "preview", title: "视频预览" },
];

export const EPISODE_WORKFLOW_STEPS = WORKFLOW_STEPS.filter((step) => step.key !== "source").map((step) => (step.key === "review" ? { ...step, title: "分集剧本" } : step));

export function episodeWorkflowEntryStep(episode: Pick<DramaEpisodeRow, "shotCount" | "stats">): "review" | "story" {
    return episode.shotCount > 0 || episode.stats.segments > 0 ? "story" : "review";
}

const STEP_INDEX = new Map(WORKFLOW_STEPS.map((step, index) => [step.key, index]));

export function workflowStepTitle(step: WorkflowStep) {
    return WORKFLOW_STEPS[STEP_INDEX.get(step) ?? 0].title;
}

function guideStep(summary: DramaSummary): DramaGuideStep | "" {
    return summary.guide?.step || summary.production.guideStep || "";
}

/** 没有引导阶段的已完成作品或旧传统制作项目：正文与配置已不在配置阶段。 */
export function isLegacyDramaWorkflow(summary: DramaSummary) {
    return !guideStep(summary);
}

/**
 * 当前阶段允许浏览的步骤。configuring 只到风格配置；之后可回看前步，不能跳到未就绪阶段。
 * completed 与传统项目可到分镜；预览不作为恢复落点，但到达分镜后可手动进入。
 */
export function allowedWorkflowSteps(summary: DramaSummary, options: { manualPreview?: boolean } = {}): WorkflowStep[] {
    const stage = guideStep(summary);
    const preview = options.manualPreview ? (["preview"] as const) : [];
    if (!stage || stage === "completed" || stage === "story") return ["source", "review", "style", "assets", "story", ...preview];
    if (stage === "assets") return ["source", "review", "style", "assets"];
    return ["source", "review", "style"];
}

export function isWorkflowStepAllowed(summary: DramaSummary, step: WorkflowStep, options?: { manualPreview?: boolean }) {
    return allowedWorkflowSteps(summary, options).includes(step);
}

/** 打开项目时的默认步骤。summary 未加载时调用方不得据此重定向。 */
export function defaultWorkflowStep(summary: DramaSummary): WorkflowStep {
    const stage = guideStep(summary);
    if (stage === "assets") return "assets";
    if (stage === "story" || stage === "completed" || !stage) return "story";
    return summary.production.chapterCount > 0 ? "review" : "source";
}

/** 只接受当前阶段允许的步骤；地址栏里的未就绪步骤回到默认步骤。 */
export function resolveWorkflowStep(summary: DramaSummary, requested?: string | null): WorkflowStep {
    const step = WORKFLOW_STEPS.find((item) => item.key === requested)?.key;
    if (step && isWorkflowStepAllowed(summary, step, { manualPreview: true })) return step;
    return defaultWorkflowStep(summary);
}
