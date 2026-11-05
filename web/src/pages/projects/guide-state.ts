import type { DramaAgentProposal } from "@/services/api/agent";
import type { DramaCast, DramaCastCreateInput, DramaCastPatch, DramaChapterInput, DramaGuideStep, DramaSettings, DramaShotPatch, DramaSourceFormat } from "@/services/api/drama";

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
    | { kind: "cast"; targetId: string; patch: DramaCastPatch; assetKind?: DramaCast["kind"] }
    | { kind: "cast_create"; input: Omit<DramaCastCreateInput, "expectedRevision"> }
    | { kind: "cast_delete"; targetId: string; reason: string }
    | { kind: "shot"; targetId: string; patch: DramaShotPatch }
    | { kind: "segment_prompt"; targetId: string; prompt: string };

export type DramaGuideProposalBatch = {
    runId: string;
    baseRevision: number;
    currentRevision: number | null;
    step: DramaGuideStep;
    appliedChanges: DramaGuideChange[];
};

function setupFields(change: Extract<DramaGuideChange, { kind: "setup" }>) {
    return new Set(Object.keys(change.patch).map((key) => (key === "styleName" || key === "stylePrompt" ? "style" : key === "aspectRatio" || key === "videoResolution" ? "frame" : key)));
}

function assetName(value: string) {
    return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function assetChange(change: DramaGuideChange) {
    return change.kind === "cast" || change.kind === "cast_create" || change.kind === "cast_delete";
}

/** 只接续明确独立的文字写入；跨资产和分镜、镜头和段提示词的影响保守视为冲突。 */
export function dramaGuideChangesConflict(left: DramaGuideChange, right: DramaGuideChange): boolean {
    if (left.kind === "setup" && right.kind === "setup") {
        const fields = setupFields(left);
        return [...setupFields(right)].some((key) => fields.has(key));
    }
    if ((left.kind === "source" && right.kind === "setup") || (left.kind === "setup" && right.kind === "source")) return false;
    if (assetChange(left) && assetChange(right)) {
        if (left.kind !== "cast_create" && right.kind !== "cast_create") {
            if ("targetId" in left && "targetId" in right && left.targetId === right.targetId) return true;
            return Boolean(left.kind === "cast" && right.kind === "cast" && left.patch.name && right.patch.name && (!left.assetKind || !right.assetKind || left.assetKind === right.assetKind) && assetName(left.patch.name) === assetName(right.patch.name));
        }
        if (left.kind === "cast_create" && right.kind === "cast_create") return left.input.kind === right.input.kind && assetName(left.input.name) === assetName(right.input.name);
        const created = left.kind === "cast_create" ? left : right.kind === "cast_create" ? right : null;
        const edited = left.kind === "cast" ? left : right.kind === "cast" ? right : null;
        return Boolean(created && edited?.patch.name && (!edited.assetKind || edited.assetKind === created.input.kind) && assetName(edited.patch.name) === assetName(created.input.name));
    }
    if (left.kind === "shot" && right.kind === "shot") return left.targetId === right.targetId;
    if (left.kind === "segment_prompt" && right.kind === "segment_prompt") return left.targetId === right.targetId;
    return true;
}

export function dramaGuideSetupChange(before: DramaSettings, after: DramaSettings): Extract<DramaGuideChange, { kind: "setup" }> | null {
    const allowed = new Set<string>([...SETUP_STRINGS, "episodeSeconds"]);
    const original = before as unknown as Record<string, unknown>;
    const updated = after as unknown as Record<string, unknown>;
    if (Object.keys({ ...original, ...updated }).some((key) => !allowed.has(key) && JSON.stringify(original[key]) !== JSON.stringify(updated[key]))) return null;
    const patch: Partial<DramaSettings> = {};
    for (const key of SETUP_STRINGS) if (before[key] !== after[key]) patch[key] = after[key];
    if (before.episodeSeconds !== after.episodeSeconds) patch.episodeSeconds = after.episodeSeconds;
    return { kind: "setup", patch };
}

/** 原始工具建议保持不变；只有本页已验证的同轮写入可以提供新的 CAS 版本。 */
export function dramaGuideProposal(proposal: DramaAgentProposal, step: DramaGuideStep, revision: number, batches: DramaGuideProposalBatch[], cast: DramaCast[] = []): { change: DramaGuideChange; revision: number } | null {
    const change = dramaGuideChange(proposal, step, proposal.baseRevision);
    if (!change) return null;
    if (change.kind === "cast") change.assetKind = cast.find((item) => item.id === change.targetId)?.kind;
    const batch = batches.find((item) => item.runId === proposal.runId && item.baseRevision === proposal.baseRevision);
    if (batch) {
        if (batch.currentRevision !== revision || batch.step !== step || batch.appliedChanges.some((applied) => dramaGuideChangesConflict(applied, change))) return null;
    } else if (proposal.baseRevision !== revision) return null;
    return { change, revision };
}

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
