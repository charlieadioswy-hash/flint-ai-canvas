import type { DramaAgentProposal } from "@/services/api/agent";
import type { DramaCastCreateInput, DramaCastPatch, DramaChapterInput, DramaGuideStep, DramaSettings, DramaShotPatch, DramaSourceFormat } from "@/services/api/drama";

export function activeDramaGuide(step?: DramaGuideStep | "") {
    return Boolean(step && step !== "completed");
}

export function dramaProjectPath(projectId: string, step?: DramaGuideStep | "") {
    const path = `/projects/${encodeURIComponent(projectId)}`;
    return activeDramaGuide(step) ? `${path}/guide` : path;
}

export function dramaProposalKey(proposal: DramaAgentProposal) {
    return `${proposal.runId}:${proposal.toolCallId}`;
}

const SETUP_STRINGS = ["aspectRatio", "styleName", "stylePrompt", "language", "videoResolution"] as const;
const CAST_STRINGS = ["name", "appearance", "description", "voiceInstructions"] as const;
const SHOT_STRINGS = ["speaker", "dialogue", "action", "shotSize", "camera", "imagePrompt", "videoPrompt"] as const;

function pickStrings<K extends string>(input: Record<string, unknown>, keys: readonly K[]) {
    const output: Partial<Record<K, string>> = {};
    for (const key of keys) if (typeof input[key] === "string") output[key] = input[key];
    return output;
}

export type DramaGuideChange =
    | { kind: "setup"; patch: Partial<DramaSettings> }
    | { kind: "source"; chapters: DramaChapterInput[]; sourceFormat?: DramaSourceFormat }
    | { kind: "cast"; targetId: string; patch: DramaCastPatch }
    | { kind: "cast_create"; input: Omit<DramaCastCreateInput, "expectedRevision"> }
    | { kind: "cast_delete"; targetId: string; reason: string }
    | { kind: "shot"; targetId: string; patch: DramaShotPatch }
    | { kind: "segment_prompt"; targetId: string; prompt: string };

/** 模型只提供待确认的文字建议；媒体、阶段推进和任意配置写入不从建议通道执行。 */
export function dramaGuideChange(proposal: DramaAgentProposal, step: DramaGuideStep, revision: number): DramaGuideChange | null {
    if (proposal.baseRevision !== revision || step === "completed") return null;
    const changes = proposal.changes;
    if (proposal.kind === "setup" && step === "configuring") {
        const patch: Partial<DramaSettings> = pickStrings(changes, SETUP_STRINGS);
        if (typeof changes.episodeSeconds === "number" && Number.isFinite(changes.episodeSeconds)) patch.episodeSeconds = changes.episodeSeconds;
        return Object.keys(patch).length ? { kind: "setup", patch } : null;
    }
    if (proposal.kind === "source" && step === "configuring" && Array.isArray(changes.chapters)) {
        const chapters: DramaChapterInput[] = [];
        for (const chapter of changes.chapters) {
            if (!chapter || typeof chapter !== "object" || typeof chapter.title !== "string" || typeof chapter.text !== "string" || !chapter.text.trim()) return null;
            chapters.push({ title: chapter.title.trim(), text: chapter.text });
        }
        if (!chapters.length) return null;
        const sourceFormat = ["novel", "script", "storyboard"].includes(changes.sourceFormat as string) ? (changes.sourceFormat as DramaSourceFormat) : undefined;
        return { kind: "source", chapters, sourceFormat };
    }
    if (proposal.kind === "cast_create" && (step === "assets" || step === "story")) {
        if (!["character", "prop", "scene"].includes(changes.kind as string) || typeof changes.name !== "string" || !changes.name.trim()) return null;
        if (changes.aliases !== undefined && (!Array.isArray(changes.aliases) || !changes.aliases.every((alias) => typeof alias === "string"))) return null;
        const input: Omit<DramaCastCreateInput, "expectedRevision"> = { ...pickStrings(changes, CAST_STRINGS), kind: changes.kind as DramaCastCreateInput["kind"], name: changes.name.trim() };
        if (Array.isArray(changes.aliases)) input.aliases = changes.aliases;
        return { kind: "cast_create", input };
    }
    if (!proposal.targetId?.trim()) return null;
    if (proposal.kind === "cast_delete" && (step === "assets" || step === "story") && typeof changes.reason === "string" && changes.reason.trim()) {
        return { kind: "cast_delete", targetId: proposal.targetId, reason: changes.reason.trim() };
    }
    if (proposal.kind === "cast" && (step === "assets" || step === "story")) {
        const patch: DramaCastPatch = pickStrings(changes, CAST_STRINGS);
        if (Array.isArray(changes.aliases) && changes.aliases.every((alias) => typeof alias === "string")) patch.aliases = changes.aliases;
        return Object.keys(patch).length ? { kind: "cast", targetId: proposal.targetId, patch } : null;
    }
    if (proposal.kind === "shot" && step === "story") {
        const patch: DramaShotPatch = pickStrings(changes, SHOT_STRINGS);
        if (typeof changes.durationSeconds === "number" && Number.isFinite(changes.durationSeconds)) patch.durationSeconds = changes.durationSeconds;
        if (["cut", "fadeblack", "fadewhite"].includes(changes.transition as string)) patch.transition = changes.transition as DramaShotPatch["transition"];
        return Object.keys(patch).length ? { kind: "shot", targetId: proposal.targetId, patch } : null;
    }
    if (proposal.kind === "segment_prompt" && step === "story" && typeof changes.videoPromptOverride === "string") return { kind: "segment_prompt", targetId: proposal.targetId, prompt: changes.videoPromptOverride };
    return null;
}
