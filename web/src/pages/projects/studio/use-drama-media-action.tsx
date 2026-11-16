import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getActiveUserScope } from "@/lib/user-scope";
import { executeDramaStudioAction, getDramaCastImpact, preflightDramaStudioAction, type DramaModelChoice, type DramaSegment, type DramaStudioActionPreflight, type DramaStudioActionRequest, type DramaWorkflowImpact } from "@/services/api/drama";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

import { dramaMediaActionKey, dramaCastImageAction, dramaVideoAction, type DramaMediaActionTarget } from "./drama-media-action-request";
export { dramaMediaActionKey, dramaCastImageAction, dramaVideoAction, type DramaMediaActionTarget } from "./drama-media-action-request";
type Episode = { id: string; number: number };
type Cast = { id: string; name?: string };
type PendingVideo = { episodeId: string; episodeNumber?: number; segmentId: string; segmentTitle?: string; videoModel?: DramaModelChoice };
export type DramaMediaQuote = { preview: DramaStudioActionPreflight | null; loading: boolean; submitting: boolean; disabled: boolean; error?: string; notice?: string };
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
    scopeKey: string;
    state: DramaMediaActionState;
    prepareAction: (request: DramaMediaActionTarget, options?: { force?: boolean }) => Promise<void>;
    prepareVideo: (episode: Episode, segment: DramaSegment, model?: DramaModelChoice) => Promise<void>;
    prepareCastImage: (cast: Cast, episodeId?: string) => Promise<void>;
    quoteAction: (request: DramaMediaActionTarget) => DramaMediaQuote;
    acknowledgeQuote: (request: DramaMediaActionTarget, preview: DramaStudioActionPreflight) => void;
    quoteVideo: (episode: Episode, segment: DramaSegment, model?: DramaModelChoice) => DramaMediaQuote;
    quoteCastImage: (cast: Cast, episodeId?: string) => DramaMediaQuote;
    requestAction: (request: DramaMediaActionTarget) => void;
    requestVideo: (episode: Episode, segment: DramaSegment, model?: DramaModelChoice) => void;
    requestCastImage: (cast: Cast, episodeId?: string) => void;
    requestMissingAssets: () => void;
    recheckVideo: () => void;
    close: () => void;
    retry: () => void;
    confirm: () => Promise<void>;
};
type Prepared = {
    account: string;
    projectId: string;
    scope: string;
    request: DramaMediaActionTarget;
    preview: DramaStudioActionPreflight | null;
    displayed: DramaStudioActionPreflight | null;
    castImpact?: DramaWorkflowImpact;
    loading: boolean;
    submitting: boolean;
    submitted: boolean;
    uncertain: boolean;
    error?: string;
    notice?: string;
    pending?: Promise<void>;
};
type Operation = { entry: Prepared; pendingVideo: PendingVideo | null; submitting: boolean };
const CLOSED: DramaMediaActionState = { open: false, request: null, preview: null, loading: false, submitting: false, submitted: false, queued: 0, pendingVideo: null };
const accountKey = () => JSON.stringify([getActiveUserScope(), useUserStore.getState().user?.id ?? null]);
function payload(request: DramaMediaActionTarget, fresh = false): DramaStudioActionRequest {
    const { episodeNumber: _episodeNumber, segmentTitle: _segmentTitle, ...input } = request;
    if (!fresh) return input;
    const { baseRevision: _baseRevision, targetRevision: _targetRevision, confirmationToken: _confirmationToken, ...intent } = input;
    return intent;
}
function sameQuote(a: DramaStudioActionPreflight, b: DramaStudioActionPreflight) {
    return (
        b.ready &&
        b.action === a.action &&
        b.targetId === a.targetId &&
        b.episodeId === a.episodeId &&
        b.confirmationToken === a.confirmationToken &&
        b.targetRevision === a.targetRevision &&
        b.baseRevision === a.baseRevision &&
        b.amountMicrocredits === a.amountMicrocredits &&
        b.priced === a.priced
    );
}
const canExecute = (p: DramaStudioActionPreflight | null) => Boolean(p?.ready && p.confirmationToken && (p.action === "segment_prompt" || (p.priced && Number.isSafeInteger(p.amountMicrocredits) && p.amountMicrocredits >= 0)));
async function inspect(projectId: string, request: DramaMediaActionTarget, fresh = false) {
    const [raw, castImpact] = await Promise.all([preflightDramaStudioAction(projectId, payload(request, fresh)), request.action === "cast_image" ? getDramaCastImpact(projectId, request.targetId) : undefined]);
    if (raw.action !== request.action || raw.targetId !== request.targetId || (request.episodeId && raw.episodeId !== request.episodeId)) throw new Error("生成对象已变化，请重新检查");
    if (request.action === "cast_image" && (castImpact?.kind !== "cast" || castImpact.castId !== request.targetId || castImpact.revision !== raw.baseRevision || !Array.isArray(castImpact.directSegments) || !Array.isArray(castImpact.continuitySegments)))
        throw new Error("资产影响范围或制作内容已变化，请重新检查");
    return { preview: raw.action === "segment_reprocess" ? { ...raw, priced: true, amountMicrocredits: 0 } : raw, castImpact };
}

/** 报价只读；点击已展示有效报价的按钮才复检并提交。 */
export function useDramaMediaAction({ projectId, revision, refreshKey, onChanged }: { projectId: string; revision?: number; refreshKey?: string; onChanged: () => void | Promise<unknown> }): DramaMediaActionController {
    const userId = useUserStore((s) => s.user?.id);
    const [state, setState] = useState<DramaMediaActionState>(CLOSED);
    const [, redraw] = useState(0);
    const cache = useRef(new Map<string, Prepared>());
    const uncertain = useRef(new Set<string>());
    const active = useRef<Operation | null>(null);
    const mounted = useRef(true);
    const context = useRef({ projectId, revision, refreshKey, onChanged });
    context.current = { projectId, revision, refreshKey, onChanged };
    const scope = useCallback(() => JSON.stringify([accountKey(), context.current.projectId, context.current.revision ?? null, context.current.refreshKey || ""]), []);
    const targetKey = useCallback((r: DramaMediaActionTarget) => JSON.stringify([accountKey(), context.current.projectId, r.action, r.targetId, r.episodeId || ""]), []);
    const current = useCallback((op: Operation) => mounted.current && active.current === op && op.entry.projectId === context.current.projectId && op.entry.account === accountKey(), []);
    const touch = useCallback(() => {
        if (mounted.current) redraw((n) => n + 1);
    }, []);
    const close = useCallback(() => {
        active.current = null;
        if (mounted.current) setState(CLOSED);
    }, []);
    useEffect(() => {
        mounted.current = true;
        const clear = () => {
            cache.current.clear();
            uncertain.current.clear();
            close();
            touch();
        };
        const unsubscribe = useUserStore.subscribe((next, previous) => {
            if (next.user?.id !== previous.user?.id) clear();
        });
        const storageChanged = () => {
            if ([...cache.current.values()].some((entry) => entry.account !== accountKey())) clear();
        };
        window.addEventListener("storage", storageChanged);
        return () => {
            mounted.current = false;
            active.current = null;
            unsubscribe();
            window.removeEventListener("storage", storageChanged);
        };
    }, [close, touch]);
    const seen = useRef({ projectId, userId });
    useEffect(() => {
        if (seen.current.projectId !== projectId || seen.current.userId !== userId) {
            cache.current.clear();
            uncertain.current.clear();
            close();
        }
        seen.current = { projectId, userId };
    }, [close, projectId, userId]);
    const find = useCallback((r: DramaMediaActionTarget) => cache.current.get(`${scope()}:${dramaMediaActionKey(r)}`), [scope]);
    const prepareAction = useCallback(
        async (input: DramaMediaActionTarget, options?: { force?: boolean }) => {
            if (!mounted.current) return;
            const key = `${scope()}:${dramaMediaActionKey(input)}`;
            const previous = cache.current.get(key);
            if (previous?.pending) return previous.pending;
            if (previous && !options?.force) return;
            if (previous?.submitted || previous?.submitting || uncertain.current.has(targetKey(input))) return;
            const request = { ...input, ...(input.videoModel ? { videoModel: { ...input.videoModel } } : {}) };
            const entry: Prepared = { account: accountKey(), projectId: context.current.projectId, scope: scope(), request, preview: null, displayed: null, loading: true, submitting: false, submitted: false, uncertain: false };
            cache.current.set(key, entry);
            touch();
            entry.pending = (async () => {
                try {
                    const result = await inspect(entry.projectId, request, Boolean(options?.force));
                    if (!mounted.current || entry.scope !== scope() || cache.current.get(key) !== entry) return;
                    entry.preview = result.preview;
                    entry.castImpact = result.castImpact;
                } catch (cause) {
                    if (!mounted.current || entry.scope !== scope() || cache.current.get(key) !== entry) return;
                    entry.error = cause instanceof Error ? cause.message : "暂时无法读取生成费用，请重试";
                } finally {
                    entry.loading = false;
                    entry.pending = undefined;
                    touch();
                }
            })();
            return entry.pending;
        },
        [scope, targetKey, touch],
    );
    const quoteAction = useCallback(
        (r: DramaMediaActionTarget): DramaMediaQuote => {
            const entry = find(r);
            const pendingReceipt = uncertain.current.has(targetKey(r));
            return {
                preview: entry?.preview || null,
                loading: entry?.loading ?? (!entry && !pendingReceipt),
                submitting: Boolean(entry?.submitting),
                disabled: Boolean(!entry || entry.loading || entry.submitting || entry.submitted || uncertain.current.has(targetKey(r)) || !canExecute(entry.preview)),
                error: entry?.error,
                notice: entry?.notice || (pendingReceipt ? "提交结果待核对，请查看制作队列，避免重复生成。" : undefined),
            };
        },
        [find, targetKey],
    );
    const acknowledgeQuote = useCallback(
        (request: DramaMediaActionTarget, preview: DramaStudioActionPreflight) => {
            const entry = find(request);
            if (entry?.preview === preview && !entry.loading) entry.displayed = preview;
        },
        [find],
    );
    const show = useCallback(
        (op: Operation, patch: Partial<DramaMediaActionState> = {}) => {
            if (!current(op)) return;
            const e = op.entry;
            setState({
                ...CLOSED,
                projectId: e.projectId,
                request: e.request,
                preview: e.preview,
                castImpact: e.castImpact,
                loading: e.loading,
                submitting: e.submitting,
                submitted: e.submitted,
                pendingVideo: op.pendingVideo,
                error: e.error,
                notice: e.notice,
                ...patch,
            });
        },
        [current],
    );
    const submit = useCallback(
        async (request: DramaMediaActionTarget, pendingVideo: PendingVideo | null) => {
            if (!mounted.current || active.current?.submitting) return;
            let entry = find(request);
            if (!entry) {
                await prepareAction(request);
                entry = find(request);
                if (!entry || canExecute(entry.preview)) return;
            }
            if (entry.submitting) return;
            const lockKey = JSON.stringify([entry.account, entry.projectId, request.action, request.targetId, request.episodeId || ""]);
            const op: Operation = { entry, pendingVideo, submitting: false };
            active.current = op;
            if (entry.loading) return;
            if (entry.submitted || uncertain.current.has(targetKey(request))) {
                show(op, { open: true, submitted: true, notice: entry.notice || "请求可能已经提交，请先核对制作队列，避免重复生成。" });
                return;
            }
            const accepted = entry.preview;
            if (!canExecute(accepted) || entry.displayed !== accepted) {
                if (!canExecute(accepted)) show(op, { open: true });
                return;
            }
            op.submitting = entry.submitting = true;
            entry.error = entry.notice = undefined;
            show(op, { open: request.action === "segment_prompt" });
            touch();
            let executing = false;
            try {
                const result = await inspect(entry.projectId, entry.request, true);
                if (!current(op)) return;
                entry.preview = result.preview;
                entry.castImpact = result.castImpact;
                if (entry.scope !== scope() || !sameQuote(accepted!, result.preview)) {
                    entry.notice = request.action === "segment_prompt" ? "条件或费用已变化，请查看最新结果后重新确认" : "生成条件或费用已更新，请查看按钮上的最新积分后再点击。";
                    show(op, { open: request.action === "segment_prompt" || !canExecute(result.preview), submitting: false });
                    return;
                }
                executing = true;
                entry.submitted = true;
                uncertain.current.add(lockKey);
                const p = result.preview;
                const receipt = await executeDramaStudioAction(entry.projectId, { ...payload(entry.request, true), baseRevision: p.baseRevision, targetRevision: p.targetRevision, confirmationToken: p.confirmationToken });
                const valid = receipt.action === p.action && receipt.targetId === p.targetId && Number.isSafeInteger(receipt.queued) && receipt.queued >= 0;
                entry.uncertain = !valid;
                entry.submitted = !valid || receipt.queued > 0;
                if (valid) uncertain.current.delete(lockKey);
                entry.notice = !valid ? "任务回执异常，请核对制作队列，避免重复提交。" : receipt.queued === 0 ? "本次没有新增任务，请核对队列后重新读取生成条件。" : undefined;
                if (!current(op)) return;
                show(op, { open: request.action === "segment_prompt" || !valid || receipt.queued === 0, submitted: entry.submitted, queued: valid ? receipt.queued : 0, submitting: false });
                try {
                    await context.current.onChanged();
                } catch {
                    show(op, { open: true, submitted: entry.submitted, queued: valid ? receipt.queued : 0, submitting: false, notice: entry.submitted ? "请求已发出，页面刷新失败，请核对制作队列，避免重复提交。" : "页面刷新失败，请刷新后核对制作队列。" });
                }
            } catch (cause) {
                const rejected = cause instanceof ApiError && (cause.status ?? 0) >= 400 && (cause.status ?? 0) < 500;
                entry.uncertain = executing && !rejected;
                entry.submitted = entry.uncertain;
                if (!entry.uncertain) uncertain.current.delete(lockKey);
                entry.preview = entry.displayed = null;
                entry.error = cause instanceof Error ? cause.message : "暂时无法提交，请重新检查";
                entry.notice = entry.uncertain ? "提交结果暂不明确，请先核对制作队列，避免重复生成。" : undefined;
                show(op, { open: true, submitting: false });
            } finally {
                op.submitting = entry.submitting = false;
                touch();
            }
        },
        [current, find, prepareAction, scope, show, targetKey, touch],
    );
    const requestAction = useCallback(
        (r: DramaMediaActionTarget) => {
            if (r.action !== "segment_prompt") {
                void submit(r, null);
                return;
            }
            if (!mounted.current || active.current?.submitting) return;
            const waiting: Operation = {
                entry: { account: accountKey(), projectId: context.current.projectId, scope: scope(), request: r, preview: null, displayed: null, loading: true, submitting: false, submitted: false, uncertain: false },
                pendingVideo: null,
                submitting: false,
            };
            active.current = waiting;
            show(waiting, { open: true });
            void prepareAction(r, { force: true }).then(() => {
                if (!current(waiting)) return;
                const entry = find(r);
                if (!entry) return;
                const op = { ...waiting, entry };
                active.current = op;
                show(op, { open: true });
            });
        },
        [current, find, prepareAction, scope, show, submit],
    );
    const requestVideo = useCallback(
        (episode: Episode, segment: DramaSegment, model?: DramaModelChoice) => {
            void submit(dramaVideoAction(episode, segment, model), { episodeId: episode.id, episodeNumber: episode.number, segmentId: segment.id, segmentTitle: segment.title, videoModel: model });
        },
        [submit],
    );
    const requestCastImage = useCallback(
        (cast: Cast, episodeId?: string) => {
            void submit(dramaCastImageAction(cast, episodeId), null);
        },
        [submit],
    );
    const prepareVideo = useCallback((episode: Episode, segment: DramaSegment, model?: DramaModelChoice) => prepareAction(dramaVideoAction(episode, segment, model)), [prepareAction]);
    const prepareCastImage = useCallback((cast: Cast, episodeId?: string) => prepareAction(dramaCastImageAction(cast, episodeId)), [prepareAction]);
    const quoteVideo = useCallback((episode: Episode, segment: DramaSegment, model?: DramaModelChoice) => quoteAction(dramaVideoAction(episode, segment, model)), [quoteAction]);
    const quoteCastImage = useCallback((cast: Cast, episodeId?: string) => quoteAction(dramaCastImageAction(cast, episodeId)), [quoteAction]);
    const retry = useCallback(() => {
        const old = active.current;
        if (!old || old.submitting || old.entry.submitted || !current(old)) return;
        void prepareAction(old.entry.request, { force: true }).then(() => {
            if (!current(old)) return;
            const entry = find(old.entry.request);
            if (!entry) return;
            const op = { ...old, entry };
            active.current = op;
            show(op, { open: entry.request.action === "segment_prompt" || !canExecute(entry.preview) });
        });
    }, [current, find, prepareAction, show]);
    const requestMissingAssets = useCallback(() => {
        const op = active.current;
        if (!op || !current(op) || op.submitting || op.entry.submitted || op.entry.request.action !== "segment_video") return;
        void submit({ ...op.entry.request, action: "segment_assets", baseRevision: undefined, targetRevision: undefined, confirmationToken: undefined }, op.pendingVideo);
    }, [current, submit]);
    const recheckVideo = useCallback(() => {
        const op = active.current;
        const p = op?.pendingVideo;
        if (!op || !current(op) || op.submitting || !p) return;
        void prepareAction({ action: "segment_video", targetId: p.segmentId, episodeId: p.episodeId, episodeNumber: p.episodeNumber, segmentTitle: p.segmentTitle, ...(p.videoModel ? { videoModel: p.videoModel } : {}) }, { force: true });
        close();
    }, [close, current, prepareAction]);
    const confirm = useCallback(async () => {
        const op = active.current;
        if (op && current(op)) await submit(op.entry.request, op.pendingVideo);
    }, [current, submit]);
    return { scopeKey: scope(), state, prepareAction, prepareVideo, prepareCastImage, quoteAction, acknowledgeQuote, quoteVideo, quoteCastImage, requestAction, requestVideo, requestCastImage, requestMissingAssets, recheckVideo, close, retry, confirm };
}

export function useDramaMediaQuote(controller: DramaMediaActionController, request: DramaMediaActionTarget | null, revision?: number) {
    const key = request ? dramaMediaActionKey(request) : "";
    const quote = request ? controller.quoteAction(request) : { preview: null, loading: false, submitting: false, disabled: true };
    useLayoutEffect(() => {
        if (request && quote.preview) controller.acknowledgeQuote(request, quote.preview);
    }, [controller.acknowledgeQuote, controller.scopeKey, key, quote.preview]);
    useEffect(() => {
        if (request) void controller.prepareAction(request);
    }, [controller.prepareAction, controller.scopeKey, key, revision]);
    return quote;
}
