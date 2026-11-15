import { useEffect, useRef, useState } from "react";
import { Button } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import { ApiError } from "@/services/api/request";
import { executeDramaStudioBatch, preflightDramaStudioBatch, type DramaStudioBatchAction, type DramaStudioBatchView } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
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
    onBusyChange?: (busy: boolean) => void;
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

function batchMatches(view: DramaStudioBatchView, action: DramaStudioBatchAction, targetIds: string[]) {
    return view.action === action && Array.isArray(view.items) && Array.isArray(view.targetIds) && JSON.stringify([...view.targetIds].sort()) === JSON.stringify(targetIds);
}

export function WorkflowBatch(props: WorkflowBatchProps) {
    const userId = useUserStore((state) => state.user?.id);
    return <WorkflowBatchSession key={`${userId}:${props.projectId}`} {...props} />;
}

/** 批次以服务端预检的范围与报价确认；执行只有一个批量请求，不逐项触发生成。 */
function WorkflowBatchSession({ projectId, revision, targetIds, actions, targetLabels = {}, disabled, onChanged, onClearSelection, triggerLabel, scopeDescription, compact, onBusyChange }: WorkflowBatchProps) {
    const operation = useDramaOperationScope(projectId);
    const ids = [...new Set(targetIds)].sort();
    const signature = JSON.stringify(ids);
    const actionSignature = JSON.stringify(actions);
    const latest = useRef({ signature, revision, actions, onChanged });
    latest.current = { signature, revision, actions, onChanged };
    const [state, setState] = useState<BatchState>(INITIAL);
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
        request.current += 1;
        locked.current = false;
        setState(INITIAL);
    }, [signature, actionSignature]);

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
            const preview = await preflightDramaStudioBatch(projectId, { action, targetIds: ids, baseRevision: startedRevision });
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

    const confirm = async () => {
        const current = stateRef.current;
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
        setState((previous) => ({ ...previous, phase: "submitting", error: undefined, notice: undefined }));
        try {
            const receipt = await executeDramaStudioBatch(projectId, { action: current.action, targetIds: ids, baseRevision: preview.baseRevision, confirmationToken: preview.confirmationToken });
            if (!operation.isCurrent(ticket) || request.current !== sequence || latest.current.signature !== startedSignature) return;
            if (!batchMatches(receipt, current.action, ids)) {
                setState((previous) => ({ ...previous, phase: "uncertain", error: "已发送批次，但回执范围无法核对。请先核对最新状态，勿重复提交。" }));
            } else setState({ open: true, action: current.action, phase: "submitted", preview: receipt, signature: startedSignature });
            await refresh(ticket, sequence);
        } catch (error) {
            if (!operation.isCurrent(ticket) || request.current !== sequence || latest.current.signature !== startedSignature) return;
            const batch = error instanceof ApiError ? (error.details?.batch as DramaStudioBatchView | undefined) : undefined;
            if (batch && batchMatches(batch, current.action, ids)) {
                setState({ open: true, action: current.action, phase: "error", signature: startedSignature, preview: batch, error: error instanceof Error ? error.message : "批次未提交，请重新预检" });
            } else setState((previous) => ({ ...previous, phase: "uncertain", error: "提交结果尚未确认，请核对最新状态后再决定是否重新预检。" }));
            await refresh(ticket, sequence);
        } finally {
            if (request.current === sequence) locked.current = false;
        }
    };

    const preview = state.preview;
    const canConfirm = state.phase === "ready" && !expired && preview?.ready && preview.priced && preview.confirmationToken && !disabled;
    const queued = preview?.counts.queued || 0;
    const close = () => {
        if (stateRef.current.phase === "submitting") return;
        request.current += 1;
        locked.current = false;
        setState(INITIAL);
    };
    return (
        <div className={`drama-workflow-batch ${compact ? "is-compact" : ""}`}>
            {!compact ? <span>已选 {ids.length} 项</span> : null}
            {actions.map((action) => (
                <Button key={action} size="small" disabled={disabled || !validScope || busy} onClick={() => void check(action)}>
                    {triggerLabel || ACTION_LABEL[action]}
                </Button>
            ))}
            {onClearSelection ? (
                <Button size="small" type="text" disabled={!ids.length || busy} onClick={onClearSelection}>
                    清空选择
                </Button>
            ) : null}
            {ids.length > 200 ? <span role="alert">每批最多选择 200 项</span> : null}
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
                        <Button key="check" disabled={busy || disabled} onClick={() => state.action && void check(state.action)}>
                            {state.phase === "uncertain" ? "核对最新状态" : "重新预检"}
                        </Button>
                    ) : null,
                    state.phase !== "submitted" && state.phase !== "uncertain" ? (
                        <Button key="confirm" type="primary" disabled={!canConfirm || busy} loading={state.phase === "submitting"} onClick={() => void confirm()}>
                            确认提交本批次
                        </Button>
                    ) : null,
                ]}
            >
                <div className="drama-root drama-workflow-batch-preview" aria-live="polite">
                    <p>{scopeDescription || `范围：已选 ${ids.length} 项。`}已有结果和已在队列中的项目将跳过。</p>
                    {state.phase === "checking" ? <p role="status">正在预检本批次的依赖、状态与费用…</p> : null}
                    {expired && state.phase !== "submitted" ? <p role="alert">配置或选择范围已改变，预检已过期，请重新预检后再确认。</p> : null}
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
