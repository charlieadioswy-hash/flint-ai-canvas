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

export function episodeWorkflowEntryStep(episode: Pick<DramaEpisodeRow, "assetsReady" | "storyboardReady">): "assets" | "review" | "story" {
    if (!episode.assetsReady) return "assets";
    return episode.storyboardReady ? "story" : "review";
}

export function episodeAssetsPending(summary: DramaSummary, episodeId?: string) {
    return Boolean(episodeId && summary.episodes?.some((episode) => episode.id === episodeId && episode.assetsReady === false));
}

export function episodeCanPreview(episode: Pick<DramaEpisodeRow, "assetsReady" | "storyboardReady">) {
    return episode.assetsReady !== false && episode.storyboardReady !== false;
}

const STEP_INDEX = new Map(WORKFLOW_STEPS.map((step, index) => [step.key, index]));
type WorkflowStepOptions = { manualPreview?: boolean; episodeId?: string };

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
 * 当前阶段允许浏览的步骤。configuring 只到风格配置；资产阶段允许回看当前集已有的分镜。
 * 本集主体就绪后可编排分镜，分镜就绪后可手动进入视频预览。
 */
export function allowedWorkflowSteps(summary: DramaSummary, options: WorkflowStepOptions = {}): WorkflowStep[] {
    const stage = guideStep(summary);
    const episode = options.episodeId ? summary.episodes?.find((item) => item.id === options.episodeId) : summary.episodes?.toSorted((left, right) => left.number - right.number)[0];
    const canPreview = options.episodeId ? (episode ? episodeCanPreview(episode) : false) : !summary.episodes?.length || summary.episodes.some(episodeCanPreview);
    const preview = options.manualPreview && canPreview ? (["preview"] as const) : [];
    if (stage !== "configuring" && episodeAssetsPending(summary, options.episodeId)) return ["source", "review", "style", "assets"];
    if (!stage || stage === "completed" || stage === "story") return ["source", "review", "style", "assets", "story", ...preview];
    if (stage === "assets") {
        const existingStoryboard = Boolean(episode && (episode.shotCount > 0 || episode.stats?.segments > 0));
        return ["source", "review", "style", "assets", ...(existingStoryboard ? (["story"] as const) : [])];
    }
    return ["source", "review", "style"];
}

export function isWorkflowStepAllowed(summary: DramaSummary, step: WorkflowStep, options?: WorkflowStepOptions) {
    return allowedWorkflowSteps(summary, options).includes(step);
}

/** 打开项目时的默认步骤。summary 未加载时调用方不得据此重定向。 */
export function defaultWorkflowStep(summary: DramaSummary, episodeId?: string): WorkflowStep {
    const stage = guideStep(summary);
    if (stage === "assets" || (stage !== "configuring" && episodeAssetsPending(summary, episodeId))) return "assets";
    if (stage === "story" || stage === "completed" || !stage) return "story";
    return summary.production.chapterCount > 0 ? "review" : "source";
}

/** 只接受当前阶段允许的步骤；地址栏里的未就绪步骤回到默认步骤。 */
export function resolveWorkflowStep(summary: DramaSummary, requested?: string | null, episodeId?: string): WorkflowStep {
    const step = WORKFLOW_STEPS.find((item) => item.key === requested)?.key;
    if (step && isWorkflowStepAllowed(summary, step, { manualPreview: true, episodeId })) return step;
    const fallback = defaultWorkflowStep(summary, episodeId);
    // The storyboard page can start generation on entry; a preview link is not that intent.
    return step === "preview" && fallback === "story" ? "review" : fallback;
}
