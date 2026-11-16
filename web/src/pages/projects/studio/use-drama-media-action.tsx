import { useCallback, useEffect, useRef, useState } from "react";

import { getActiveUserScope } from "@/lib/user-scope";
import { executeDramaStudioAction, getDramaCastImpact, preflightDramaStudioAction, type DramaModelChoice, type DramaSegment, type DramaStudioActionPreflight, type DramaStudioActionRequest, type DramaWorkflowImpact } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";
import { generatedCastVideoSegments } from "../workflow-impact";

export type DramaMediaActionTarget = DramaStudioActionRequest & { episodeNumber?: number; segmentTitle?: string };
type PendingVideo = { episodeId: string; episodeNumber?: number; segmentId: string; segmentTitle?: string; videoModel?: DramaModelChoice };

export type DramaMediaActionState = {
    open: boolean;
    projectId?: string;
    request: DramaMediaActionTarget | null;
    preview: DramaStudioActionPreflight | null;
    castImpact?: DramaWorkflowImpact;
    loading: boolean;
    submitting: boolean;
    submitted: boolean;
    queued: number;
    error?: string;
    notice?: string;
    pendingVideo: PendingVideo | null;
};

export type DramaMediaActionController = {
    state: DramaMediaActionState;
    requestAction: (request: DramaMediaActionTarget) => void;
    requestVideo: (episode: { id: string; number: number }, segment: DramaSegment, videoModel?: DramaModelChoice) => void;
    requestCastImage: (cast: { id: string; name?: string }, episodeId?: string) => void;
    requestMissingAssets: () => void;
    recheckVideo: () => void;
    close: () => void;
    retry: () => void;
    confirm: () => Promise<void>;
};

type Operation = {
    account: string;
    projectId: string;
    request: DramaMediaActionTarget;
    pendingVideo: PendingVideo | null;
    preview: DramaStudioActionPreflight | null;
    castImpact?: DramaWorkflowImpact;
    submitting: boolean;
    submitted: boolean;
};

const CLOSED: DramaMediaActionState = { open: false, request: null, preview: null, loading: false, submitting: false, submitted: false, queued: 0, pendingVideo: null };

function accountKey() {
    return JSON.stringify([getActiveUserScope(), useUserStore.getState().user?.id ?? null]);
}

function payload(request: DramaMediaActionTarget, fresh = false): DramaStudioActionRequest {
    const { episodeNumber: _episodeNumber, segmentTitle: _segmentTitle, ...input } = request;
    if (!fresh) return input;
    const { baseRevision: _baseRevision, targetRevision: _targetRevision, confirmationToken: _confirmationToken, ...intent } = input;
    return intent;
}

function sameQuote(accepted: DramaStudioActionPreflight, current: DramaStudioActionPreflight) {
    return (
        current.ready &&
        current.action === accepted.action &&
        current.targetId === accepted.targetId &&
        current.episodeId === accepted.episodeId &&
        current.confirmationToken === accepted.confirmationToken &&
        current.targetRevision === accepted.targetRevision &&
        current.baseRevision === accepted.baseRevision &&
        current.amountMicrocredits === accepted.amountMicrocredits &&
        current.priced === accepted.priced
    );
}

async function inspectMediaAction(projectId: string, request: DramaMediaActionTarget, fresh = false) {
    const [preview, castImpact] = await Promise.all([
        preflightDramaStudioAction(projectId, payload(request, fresh)),
        request.action === "cast_image"
            ? getDramaCastImpact(projectId, request.targetId).catch((cause: unknown) => {
                  throw new Error(cause instanceof Error ? `已有视频依赖读取失败：${cause.message}` : "已有视频依赖读取失败，请重试");
              })
            : undefined,
    ]);
    if (preview.action !== request.action || preview.targetId !== request.targetId || (request.episodeId && preview.episodeId !== request.episodeId)) throw new Error("生成对象已变化，请重新打开操作");
    if (
        request.action === "cast_image" &&
        (castImpact?.kind !== "cast" || castImpact.castId !== request.targetId || castImpact.revision !== preview.baseRevision || !Array.isArray(castImpact.directSegments) || !Array.isArray(castImpact.continuitySegments))
    )
        throw new Error("资产影响范围或制作内容已变化，请重新检查");
    return { preview, castImpact };
}

function generatedCastScope(impact?: DramaWorkflowImpact) {
    const direct = new Set(impact?.directSegments.map((segment) => segment.id));
    const generated = impact ? generatedCastVideoSegments(impact) : [];
    return JSON.stringify(generated.sort((a, b) => a.id.localeCompare(b.id)).map((segment) => [segment.id, segment.episodeId, segment.episodeNumber, segment.episodeTitle, segment.segmentIndex, direct.has(segment.id)]));
}

/** 媒体确认只调用业务预检和执行；授权仅存在当前打开的操作中。 */
export function useDramaMediaAction({ projectId, onChanged }: { projectId: string; onChanged: () => void | Promise<unknown> }): DramaMediaActionController {
    const userId = useUserStore((store) => store.user?.id);
    const [state, setState] = useState<DramaMediaActionState>(CLOSED);
    const active = useRef<Operation | null>(null);
    const mounted = useRef(true);
    const project = useRef(projectId);
    const changed = useRef(onChanged);
    project.current = projectId;
    changed.current = onChanged;

    const current = useCallback((operation: Operation) => mounted.current && active.current === operation && operation.projectId === project.current && operation.account === accountKey(), []);
    const update = useCallback(
        (operation: Operation, patch: Partial<DramaMediaActionState>) => {
            if (current(operation)) setState((previous) => (current(operation) && previous.request === operation.request ? { ...previous, ...patch } : previous));
        },
        [current],
    );
    const close = useCallback(() => {
        active.current = null;
        if (mounted.current) setState(CLOSED);
    }, []);

    useEffect(() => {
        mounted.current = true;
        const unsubscribe = useUserStore.subscribe((next, previous) => {
            if (next.user?.id !== previous.user?.id) close();
        });
        const storageChanged = () => {
            if (active.current && active.current.account !== accountKey()) close();
        };
        window.addEventListener("storage", storageChanged);
        return () => {
            mounted.current = false;
            active.current = null;
            unsubscribe();
            window.removeEventListener("storage", storageChanged);
        };
    }, [close]);

    const seen = useRef({ projectId, userId });
    useEffect(() => {
        if (seen.current.projectId !== projectId || seen.current.userId !== userId) close();
        seen.current = { projectId, userId };
    }, [close, projectId, userId]);

    const begin = useCallback(
        (input: DramaMediaActionTarget, pendingVideo: PendingVideo | null, notice?: string) => {
            if (!mounted.current) return;
            const request = { ...input, ...(input.videoModel ? { videoModel: { ...input.videoModel } } : {}) };
            const operation: Operation = { account: accountKey(), projectId: project.current, request, pendingVideo, preview: null, submitting: false, submitted: false };
            active.current = operation;
            setState({ ...CLOSED, open: true, projectId: operation.projectId, request, pendingVideo, loading: true, notice });
            void inspectMediaAction(operation.projectId, request)
                .then(({ preview, castImpact }) => {
                    if (!current(operation)) return;
                    operation.preview = preview;
                    operation.castImpact = castImpact;
                    update(operation, { preview, castImpact, loading: false, error: undefined });
                })
                .catch((cause: unknown) => {
                    if (!current(operation)) return;
                    operation.preview = null;
                    operation.castImpact = undefined;
                    update(operation, { preview: null, castImpact: undefined, loading: false, error: cause instanceof Error ? cause.message : "暂时无法检查生成条件，请重试" });
                });
        },
        [current, update],
    );

    const requestAction = useCallback((request: DramaMediaActionTarget) => begin(request, null), [begin]);
    const requestVideo = useCallback(
        (episode: { id: string; number: number }, segment: DramaSegment, videoModel?: DramaModelChoice) => {
            begin(
                { action: "segment_video", targetId: segment.id, episodeId: episode.id, episodeNumber: episode.number, segmentTitle: segment.title, targetRevision: segment.revision, ...(videoModel ? { videoModel } : {}) },
                { episodeId: episode.id, episodeNumber: episode.number, segmentId: segment.id, segmentTitle: segment.title, videoModel },
            );
        },
        [begin],
    );
    const requestCastImage = useCallback((cast: { id: string; name?: string }, episodeId?: string) => begin({ action: "cast_image", targetId: cast.id, segmentTitle: cast.name, ...(episodeId ? { episodeId } : {}) }, null), [begin]);

    const requestMissingAssets = useCallback(() => {
        const operation = active.current;
        const preview = operation?.preview;
        if (!operation || !current(operation) || operation.request !== state.request || operation.submitting || operation.submitted || preview?.action !== "segment_video" || !preview.missingCasts.length || !preview.episodeId) return;
        const pending = operation.pendingVideo ?? { episodeId: preview.episodeId, episodeNumber: operation.request.episodeNumber, segmentId: preview.targetId, segmentTitle: operation.request.segmentTitle, videoModel: operation.request.videoModel };
        begin(
            { action: "segment_assets", targetId: preview.targetId, episodeId: preview.episodeId, episodeNumber: pending.episodeNumber, segmentTitle: pending.segmentTitle, ...(pending.videoModel ? { videoModel: pending.videoModel } : {}) },
            pending,
            "只生成缺失的参考图；生成视频需另行确认。",
        );
    }, [begin, current, state.request]);

    const recheckVideo = useCallback(() => {
        const operation = active.current;
        const pending = operation?.pendingVideo;
        if (!operation || !current(operation) || operation.request !== state.request || operation.submitting || !operation.submitted || operation.request.action !== "segment_assets" || !pending) return;
        begin({ action: "segment_video", targetId: pending.segmentId, episodeId: pending.episodeId, episodeNumber: pending.episodeNumber, segmentTitle: pending.segmentTitle, ...(pending.videoModel ? { videoModel: pending.videoModel } : {}) }, pending);
    }, [begin, current, state.request]);

    const retry = useCallback(() => {
        const operation = active.current;
        if (!operation || !current(operation) || operation.request !== state.request || operation.submitting || operation.submitted) return;
        begin({ ...operation.request, ...payload(operation.request, true), baseRevision: undefined, targetRevision: undefined, confirmationToken: undefined }, operation.pendingVideo);
    }, [begin, current, state.request]);

    const confirm = useCallback(async () => {
        const operation = active.current;
        const quote = operation?.preview;
        if (!operation || !current(operation) || operation.request !== state.request || quote !== state.preview || operation.submitting || operation.submitted || !quote?.ready || !quote.confirmationToken) return;
        if (operation.request.action === "cast_image" && (!operation.castImpact || operation.castImpact !== state.castImpact)) return;
        operation.submitting = true;
        update(operation, { submitting: true, error: undefined, notice: undefined });
        try {
            const { preview: fresh, castImpact } = await inspectMediaAction(operation.projectId, operation.request, true);
            if (!current(operation)) return;
            const impactChanged = operation.request.action === "cast_image" && generatedCastScope(operation.castImpact) !== generatedCastScope(castImpact);
            operation.preview = fresh;
            operation.castImpact = castImpact;
            if (!sameQuote(quote, fresh) || impactChanged) {
                update(operation, {
                    preview: fresh,
                    castImpact,
                    submitting: false,
                    notice: impactChanged ? "已有视频依赖范围已变化，请查看最新提示后重新确认" : operation.request.action === "segment_reprocess" ? "处理条件已变化，请查看最新结果后重新确认" : "条件或费用已变化，请查看最新结果后重新确认",
                });
                return;
            }
            const executed = await executeDramaStudioAction(operation.projectId, { ...payload(operation.request, true), baseRevision: fresh.baseRevision, targetRevision: fresh.targetRevision, confirmationToken: fresh.confirmationToken });
            if (!current(operation)) return;
            operation.preview = null;
            const validReceipt = Number.isSafeInteger(executed.queued) && executed.queued >= 0;
            const queued = validReceipt ? executed.queued : 0;
            operation.submitted = !validReceipt || queued > 0;
            update(operation, {
                preview: queued ? fresh : null,
                castImpact,
                submitting: false,
                submitted: operation.submitted,
                queued,
                notice: !validReceipt ? "任务回执异常，请刷新队列确认，避免重复提交。" : queued ? undefined : "本次没有新增任务，请查看当前队列后重新检查。",
            });
            try {
                await changed.current();
            } catch {
                update(operation, { notice: !validReceipt ? "任务回执异常，页面刷新失败，请刷新队列确认，避免重复提交。" : queued ? "任务已提交，页面刷新失败，请刷新页面查看队列。" : "本次没有新增任务，页面刷新失败，请刷新后查看当前状态。" });
            }
        } catch (cause) {
            if (!current(operation)) return;
            operation.preview = null;
            operation.castImpact = undefined;
            update(operation, { preview: null, castImpact: undefined, submitting: false, error: cause instanceof Error ? cause.message : "提交失败，请重新检查后重试" });
        } finally {
            operation.submitting = false;
        }
    }, [current, state.castImpact, state.preview, state.request, update]);

    return { state, requestAction, requestVideo, requestCastImage, requestMissingAssets, recheckVideo, close, retry, confirm };
}
