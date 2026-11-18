import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Popover } from "antd";
import { ChevronDown } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import { ApiError } from "@/services/api/request";
import { executeDramaStudioBatch, preflightDramaStudioBatch, type DramaModelChoice, type DramaStudioBatchAction, type DramaStudioBatchView } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { generationLabel } from "./workflow-generation";
import "./workflow-batch.css";

const ACTION_LABEL: Record<DramaStudioBatchAction, string> = {
    cast_image: "批量生成参考图",
    segment_assets: "批量生成缺失资产",
    segment_prompt: "批量撰写提示词",
    segment_video: "批量生成视频",
};
const STATUS_LABEL = { ready: "可提交", queued: "已入队", already_queued: "已在队列", skipped_ready: "已有结果", blocked: "条件未满足", conflict: "内容已改变", failed: "失败" };

export type WorkflowBatchProps = {
    projectId: string;
    episodeId?: string;
    revision: number;
    targetIds: string[];
    actions: DramaStudioBatchAction[];
    targetLabels?: Record<string, string>;
    disabled?: boolean;
    onChanged: () => void | Promise<unknown>;
    onClearSelection?: () => void;
    triggerLabel?: string;
    scopeDescription?: string;
    compact?: boolean;
    popover?: boolean;
    noticeMount?: HTMLElement | null;
    onBusyChange?: (busy: boolean) => void;
    regenerate?: boolean;
    restyleSegments?: boolean;
    videoModel?: DramaModelChoice;
};

type BatchState = {
    open: boolean;
    action?: DramaStudioBatchAction;
    phase: "idle" | "checking" | "ready" | "submitting" | "submitted" | "uncertain" | "error";
    preview?: DramaStudioBatchView;
    signature?: string;
    error?: string;
    notice?: string;
};
const INITIAL: BatchState = { open: false, phase: "idle" };
type ButtonQuote = { signature: string; loading: boolean; preview?: DramaStudioBatchView; error?: string };

function batchMatches(view: DramaStudioBatchView, action: DramaStudioBatchAction, targetIds: string[]) {
    return view.action === action && Array.isArray(view.items) && Array.isArray(view.targetIds) && JSON.stringify([...view.targetIds].sort()) === JSON.stringify(targetIds);
}

export function WorkflowBatch(props: WorkflowBatchProps) {
    const userId = useUserStore((state) => state.user?.id);
    return <WorkflowBatchSession key={`${userId}:${props.projectId}`} {...props} />;
}

/** 批次以服务端预检的范围与报价确认；执行只有一个批量请求，不逐项触发生成。 */
function WorkflowBatchSession({
    projectId,
    episodeId,
    revision,
    targetIds,
    actions,
    targetLabels = {},
    disabled,
    onChanged,
    onClearSelection,
    triggerLabel,
    scopeDescription,
    compact,
    popover,
    noticeMount,
    onBusyChange,
    regenerate,
    restyleSegments,
    videoModel,
}: WorkflowBatchProps) {
    const operation = useDramaOperationScope(projectId);
    const ids = [...new Set(targetIds)].sort();
    const signature = JSON.stringify([episodeId || "", ids, Boolean(regenerate), Boolean(restyleSegments), videoModel]);
    const batchOptions = { ...(regenerate ? { regenerate: true } : {}), ...(restyleSegments ? { restyleSegments: true } : {}), ...(videoModel ? { videoModel } : {}) };
    const actionSignature = JSON.stringify(actions);
    const latest = useRef({ signature, revision, actions, onChanged });
    latest.current = { signature, revision, actions, onChanged };
    const [state, setState] = useState<BatchState>(INITIAL);
    const [buttonQuotes, setButtonQuotes] = useState<Partial<Record<DramaStudioBatchAction, ButtonQuote>>>({});
    const [quoteEpoch, setQuoteEpoch] = useState(0);
    const [actionsOpen, setActionsOpen] = useState(false);
    const triggerHost = useRef<HTMLSpanElement>(null);
    const focusAction = useCallback((node: HTMLDivElement | null) => node?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(), []);
    const quoteSignature = JSON.stringify([signature, revision, quoteEpoch]);
    const stateRef = useRef(state);
    stateRef.current = state;
    const request = useRef(0);
    const locked = useRef(false);
    const busy = state.phase === "checking" || state.phase === "submitting";
    const activity = useRef(onBusyChange);
    activity.current = onBusyChange;
    useEffect(() => {
        activity.current?.(busy);
    }, [busy]);
    useEffect(() => () => activity.current?.(false), []);
    const validScope = Boolean(projectId && projectId.trim() === projectId) && ids.length > 0 && ids.length <= 200 && ids.every((id) => id.trim() === id && Boolean(id));
    const expired = Boolean(state.preview && (state.preview.baseRevision !== revision || state.signature !== signature));

    useEffect(() => {
        if (stateRef.current.phase !== "submitting" && stateRef.current.phase !== "uncertain") {
            request.current += 1;
            locked.current = false;
            setState(INITIAL);
        }
    }, [signature, actionSignature]);

    useEffect(() => {
        if (disabled || !validScope) return;
        const ticket = operation.capture();
        let alive = true;
        const mediaActions = actions.filter((action) => action !== "segment_prompt");
        setButtonQuotes(Object.fromEntries(mediaActions.map((action) => [action, { signature: quoteSignature, loading: true }])));
        const timer = setTimeout(() => {
            for (const action of mediaActions) {
                void preflightDramaStudioBatch(projectId, { action, targetIds: ids, baseRevision: revision, ...batchOptions, ...(episodeId ? { episodeId } : {}) }).then(
                    (preview) => {
                        if (!alive || !operation.isCurrent(ticket)) return;
                        setButtonQuotes((previous) => ({ ...previous, [action]: { signature: quoteSignature, loading: false, ...(batchMatches(preview, action, ids) ? { preview } : { error: "生成范围已变化，请重新读取" }) } }));
                    },
                    (error: unknown) => {
                        if (!alive || !operation.isCurrent(ticket)) return;
                        setButtonQuotes((previous) => ({ ...previous, [action]: { signature: quoteSignature, loading: false, error: error instanceof Error ? error.message : "图片或视频计价失败" } }));
                    },
                );
            }
        }, 180);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [projectId, episodeId, signature, actionSignature, revision, quoteSignature, disabled, validScope]);

    const refresh = async (ticket: ReturnType<typeof operation.capture>, sequence: number) => {
        try {
            await latest.current.onChanged();
        } catch (error) {
            if (operation.isCurrent(ticket) && request.current === sequence) setState((current) => ({ ...current, notice: `批次结果已保留，刷新队列失败：${error instanceof Error ? error.message : "请稍后刷新"}` }));
        }
    };

    const check = async (action: DramaStudioBatchAction) => {
        if (disabled || !validScope || locked.current || !actions.includes(action)) return;
        const ticket = operation.capture();
        const sequence = ++request.current;
        const startedSignature = signature;
        const startedRevision = revision;
        locked.current = true;
        setState({ open: true, action, phase: "checking", signature: startedSignature });
        try {
            const preview = await preflightDramaStudioBatch(projectId, { action, targetIds: ids, baseRevision: startedRevision, ...(episodeId ? { episodeId } : {}) });
            if (!operation.isCurrent(ticket) || request.current !== sequence || latest.current.signature !== startedSignature || !latest.current.actions.includes(action)) return;
            if (!batchMatches(preview, action, ids)) throw new Error("批次范围与预检结果不一致，请重新预检");
            setState({ open: true, action, phase: "ready", preview, signature: startedSignature });
        } catch (error) {
            if (!operation.isCurrent(ticket) || request.current !== sequence || latest.current.signature !== startedSignature) return;
            const batch = error instanceof ApiError ? (error.details?.batch as DramaStudioBatchView | undefined) : undefined;
            setState({ open: true, action, phase: "error", signature: startedSignature, ...(batch && batchMatches(batch, action, ids) ? { preview: batch } : {}), error: error instanceof Error ? error.message : "批量预检失败，请重试" });
        } finally {
            if (request.current === sequence) locked.current = false;
        }
    };

    const confirm = async (prepared?: BatchState) => {
        const current = prepared || stateRef.current;
        const preview = current.preview;
        if (
            disabled ||
            locked.current ||
            current.phase !== "ready" ||
            !preview?.ready ||
            !preview.priced ||
            !preview.confirmationToken ||
            preview.baseRevision !== latest.current.revision ||
            current.signature !== latest.current.signature ||
            !current.action ||
            !latest.current.actions.includes(current.action)
        )
            return;
        const ticket = operation.capture();
        const sequence = ++request.current;
        const startedSignature = signature;
        locked.current = true;
        setState({ ...current, phase: "submitting", error: undefined, notice: undefined });
        try {
            const receipt = await executeDramaStudioBatch(projectId, { action: current.action, targetIds: ids, baseRevision: preview.baseRevision, confirmationToken: preview.confirmationToken, ...batchOptions, ...(episodeId ? { episodeId } : {}) });
            if (!operation.isCurrent(ticket) || request.current !== sequence) return;
            if (!batchMatches(receipt, current.action, ids)) {
                setState((previous) => ({ ...previous, open: true, phase: "uncertain", error: "已发送批次，但回执范围无法核对。请先核对最新状态，勿重复提交。" }));
            } else setState({ open: current.action === "segment_prompt", action: current.action, phase: "submitted", preview: receipt, signature: startedSignature });
            await refresh(ticket, sequence);
        } catch (error) {
            if (!operation.isCurrent(ticket) || request.current !== sequence) return;
            const batch = error instanceof ApiError ? (error.details?.batch as DramaStudioBatchView | undefined) : undefined;
            if (batch && batchMatches(batch, current.action, ids)) {
                setState({ open: true, action: current.action, phase: "error", signature: startedSignature, preview: batch, error: error instanceof Error ? error.message : "批次未提交，请重新预检" });
            } else setState((previous) => ({ ...previous, open: true, phase: "uncertain", error: "提交结果尚未确认，请核对最新状态，勿重复生成。" }));
            await refresh(ticket, sequence);
        } finally {
            if (request.current === sequence) {
                locked.current = false;
                setQuoteEpoch((value) => value + 1);
            }
        }
    };

    const preview = state.preview;
    const canConfirm = state.phase === "ready" && !expired && preview?.ready && preview.priced && preview.confirmationToken && !disabled;
    const queued = preview?.counts.queued || 0;
    const recover = async () => {
        const current = stateRef.current;
        if (locked.current || !current.action || !current.preview || !current.signature) return;
        const ticket = operation.capture();
        const sequence = ++request.current;
        const [originalEpisode, , originalRegenerate, originalRestyle, originalModel] = JSON.parse(current.signature) as [string, string[], boolean, boolean, DramaModelChoice?];
        locked.current = true;
        try {
            const result = await preflightDramaStudioBatch(projectId, {
                action: current.action,
                targetIds: current.preview.targetIds,
                ...(originalEpisode ? { episodeId: originalEpisode } : {}),
                ...(originalRegenerate ? { regenerate: true } : {}),
                ...(originalRestyle ? { restyleSegments: true } : {}),
                ...(originalModel ? { videoModel: originalModel } : {}),
            });
            if (!operation.isCurrent(ticket) || request.current !== sequence) return;
            const pendingTargets = current.preview.items.filter((item) => item.status === "ready");
            const resolved =
                batchMatches(result, current.action, [...current.preview.targetIds].sort()) &&
                pendingTargets.length > 0 &&
                pendingTargets.every((original) =>
                    result.items.some(
                        (item) =>
                            item.targetId === original.targetId &&
                            (item.status === "already_queued" ||
                                item.status === "skipped_ready" ||
                                (originalRegenerate && typeof original.resultVersion === "number" && (item.resultVersion || 0) > original.resultVersion && Boolean(item.resultResourceId))),
                    ),
                );
            setState({
                ...current,
                open: true,
                phase: resolved ? "submitted" : "uncertain",
                preview: resolved ? result : current.preview,
                error: resolved ? undefined : "尚未核对到全部任务，请稍后再次核对，勿重复生成。",
                notice: resolved ? "已核对到任务或生成结果，无需重复提交。" : undefined,
            });
            if (resolved) await refresh(ticket, sequence);
        } catch (error) {
            if (operation.isCurrent(ticket) && request.current === sequence) setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : "状态读取失败，请稍后核对" }));
        } finally {
            if (request.current === sequence) locked.current = false;
        }
    };
    const close = () => {
        if (stateRef.current.phase === "submitting") return;
        request.current += 1;
        locked.current = false;
        setState((current) => (current.phase === "uncertain" ? { ...current, open: false } : INITIAL));
    };
    const canOpenActions = ids.length > 0 || state.phase === "uncertain";
    const closeActions = () => {
        if (!popover) return;
        setActionsOpen(false);
        triggerHost.current?.querySelector("button")?.focus();
    };
    const actionButtons = (
        <>
            {actions.map((action) => {
                const quoted = buttonQuotes[action]?.signature === quoteSignature ? buttonQuotes[action] : undefined;
                const media = action !== "segment_prompt";
                const canGenerate = quoted?.preview?.ready && quoted.preview.priced && quoted.preview.confirmationToken;
                const reason = quoted?.error || quoted?.preview?.reason || quoted?.preview?.items.find((item) => item.status === "blocked" || item.status === "failed" || item.status === "conflict")?.reason;
                const label = triggerLabel || (action === "cast_image" ? "批量生成图片" : action === "segment_assets" ? "生成缺失图片" : ACTION_LABEL[action]);
                const readyCount = quoted?.preview?.counts.ready || 0;
                const scopedLabel = action === "segment_video" && readyCount > 0 && readyCount < ids.length ? `${label}（${readyCount}/${ids.length}段）` : label;
                return (
                    <Button
                        key={action}
                        size="small"
                        disabled={disabled || !validScope || busy || state.phase === "uncertain" || (media && !canGenerate)}
                        title={reason}
                        loading={busy && state.action === action}
                        onClick={() => {
                            closeActions();
                            if (media) void confirm({ open: false, action, phase: "ready", preview: quoted?.preview, signature });
                            else void check(action);
                        }}
                    >
                        {media ? generationLabel(scopedLabel, quoted?.preview, Boolean(validScope && !disabled && (!quoted || quoted.loading))) : label}
                    </Button>
                );
            })}
            {onClearSelection ? (
                <Button
                    size="small"
                    type="text"
                    disabled={!ids.length || busy}
                    onClick={() => {
                        closeActions();
                        onClearSelection();
                    }}
                >
                    清空选择
                </Button>
            ) : null}
            {state.phase === "uncertain" && !state.open ? (
                <Button
                    size="small"
                    onClick={() => {
                        closeActions();
                        setState((current) => ({ ...current, open: true }));
                    }}
                >
                    查看待核对批次
                </Button>
            ) : null}
            {actions.some((action) => buttonQuotes[action]?.error) && state.phase !== "uncertain" ? (
                <Button size="small" type="text" disabled={busy || disabled} onClick={() => setQuoteEpoch((value) => value + 1)}>
                    重新计价
                </Button>
            ) : null}
        </>
    );
    const notices = [
        ids.length > 200 ? (
            <span key="scope" role="alert">
                每批最多选择 200 项
            </span>
        ) : null,
        ...actions
            .filter((action) => action !== "segment_prompt")
            .map((action) => {
                const quoted = buttonQuotes[action]?.signature === quoteSignature ? buttonQuotes[action] : undefined;
                const reason = quoted?.error || quoted?.preview?.reason || quoted?.preview?.items.find((item) => item.status === "blocked" || item.status === "failed" || item.status === "conflict")?.reason;
                return reason ? (
                    <span key={action} role="status">
                        {reason}
                    </span>
                ) : null;
            }),
        !state.open && state.phase === "submitted" ? (
            <span key="queued" role="status">
                已加入队列 {queued} 项
            </span>
        ) : null,
        !state.open && state.notice ? (
            <span key="refresh" role="status">
                {state.notice}
            </span>
        ) : null,
    ].filter(Boolean);
    return (
        <div className={`drama-workflow-batch ${compact ? "is-compact" : ""}`}>
            {!compact ? <span>已选 {ids.length} 项</span> : null}
            {popover ? (
                <span
                    ref={triggerHost}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape" || !actionsOpen) return;
                        event.stopPropagation();
                        closeActions();
                    }}
                >
                    <Popover
                        trigger="click"
                        placement="bottomRight"
                        open={actionsOpen && canOpenActions}
                        onOpenChange={(open) => setActionsOpen(open && canOpenActions && !busy)}
                        destroyOnHidden
                        content={
                            <div ref={focusAction} className="drama-workflow-batch-popover" role="dialog" aria-label="批量操作">
                                <p className="drama-workflow-batch-scope">{scopeDescription || `已选 ${ids.length} 段`}</p>
                                {actionButtons}
                            </div>
                        }
                    >
                        <Button
                            size="small"
                            icon={<ChevronDown className="size-3.5" />}
                            iconPlacement="end"
                            aria-label={`批量操作，已选 ${ids.length} 段`}
                            aria-haspopup="dialog"
                            aria-expanded={actionsOpen && canOpenActions}
                            aria-disabled={!canOpenActions || busy}
                            loading={busy}
                        >
                            批量操作{ids.length ? ` · ${ids.length} 段` : ""}
                        </Button>
                    </Popover>
                </span>
            ) : (
                actionButtons
            )}
            {noticeMount === undefined ? notices : noticeMount && notices.length ? createPortal(<div className="drama-workflow-batch-notices">{notices}</div>, noticeMount) : null}
            <AppModal
                open={state.open}
                title={state.action ? ACTION_LABEL[state.action] : "批量制作"}
                width={640}
                onCancel={close}
                closable={state.phase !== "submitting"}
                maskClosable={!busy}
                footer={[
                    <Button key="close" disabled={state.phase === "submitting"} onClick={close}>
                        {state.phase === "submitted" ? "关闭" : "取消"}
                    </Button>,
                    state.action && state.phase !== "submitted" ? (
                        <Button key="check" disabled={busy || disabled} onClick={() => (state.phase === "uncertain" ? void recover() : state.action === "segment_prompt" ? void check(state.action) : (close(), setQuoteEpoch((value) => value + 1)))}>
                            {state.phase === "uncertain" ? "核对最新状态" : state.action === "segment_prompt" ? "重新预检" : "重新计价"}
                        </Button>
                    ) : null,
                    state.action === "segment_prompt" && state.phase !== "submitted" && state.phase !== "uncertain" ? (
                        <Button key="confirm" type="primary" disabled={!canConfirm || busy} loading={state.phase === "submitting"} onClick={() => void confirm()}>
                            确认提交本批次
                        </Button>
                    ) : null,
                ]}
            >
                <div className="drama-root drama-workflow-batch-preview" aria-live="polite">
                    <p>
                        {scopeDescription || `范围：已选 ${preview?.targetIds.length || ids.length} 项。`}
                        {regenerate ? "已在队列中的项目将跳过。" : "已有结果和已在队列中的项目将跳过。"}
                    </p>
                    {state.phase === "checking" ? <p role="status">正在预检本批次的依赖、状态与费用…</p> : null}
                    {expired && state.phase !== "submitted" && state.phase !== "uncertain" ? <p role="alert">配置或选择范围已改变，请重新读取费用。</p> : null}
                    {state.error ? <p role="alert">{state.error}</p> : null}
                    {state.notice ? <p role="status">{state.notice}</p> : null}
                    {preview ? (
                        <>
                            <p className="drama-workflow-batch-price">{preview.priced ? `预计合计 ${formatDramaCredits(preview.amountMicrocredits)} 积分` : "费用尚未确认，请检查模型计费配置后重新预检"}</p>
                            {preview.reason ? <p role="status">{preview.reason}</p> : null}
                            {state.phase === "submitted" ? <p role="status">{queued ? `已加入队列 ${queued} 项，可在制作队列查看进度。` : "本批次没有新增任务，请按下方逐项状态核对。"}</p> : null}
                            {preview.dispatchPending ? <p role="status">任务已入队，正在等待调度，无需重复提交。</p> : null}
                            {preview.warnings?.map((warning) => (
                                <p key={warning} role="status">
                                    {warning}
                                </p>
                            ))}
                            <div className="drama-workflow-batch-items thin-scrollbar" aria-label="批次逐项状态">
                                {preview.items.map((item) => (
                                    <div key={`${item.targetKind}:${item.targetId}`} className="drama-workflow-batch-item" data-status={item.status}>
                                        <div>
                                            <strong>{item.name || targetLabels[item.targetId] || (item.segmentIndex === undefined ? "所选资产或剧情段" : `第 ${item.segmentIndex + 1} 段`)}</strong>
                                            <span>{STATUS_LABEL[item.status]}</span>
                                        </div>
                                        {item.reason ? <p>{item.reason}</p> : null}
                                        {item.missingCasts?.length ? <p>缺少参考图：{item.missingCasts.map((cast) => cast.name).join("、")}</p> : null}
                                        {item.warnings?.map((warning) => (
                                            <p key={warning}>{warning}</p>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </>
                    ) : null}
                </div>
            </AppModal>
        </div>
    );
}
