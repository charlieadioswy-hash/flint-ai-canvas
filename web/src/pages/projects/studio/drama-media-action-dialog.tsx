import { Button } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import type { DramaStudioAction } from "@/services/api/drama";
import { CastVideoImpact } from "../workflow-impact";
import { generationLabel } from "../workflow-generation";
import { useDramaMediaQuote, type DramaMediaActionController, type DramaMediaActionTarget } from "./use-drama-media-action";

const ACTION_LABEL: Record<DramaStudioAction, string> = {
    cast_image: "生成参考图",
    segment_assets: "生成缺失的资产",
    segment_video: "生成本段视频",
    segment_prompt: "重新撰写本段提示词",
    segment_reprocess: "重新处理已有视频",
};

function scopeLabel(controller: DramaMediaActionController) {
    const request = controller.state.request;
    const preview = controller.state.preview;
    if (!request) return "";
    const action = preview?.action || request.action;
    const parts = [ACTION_LABEL[action]];
    if (action !== "cast_image" && request.episodeNumber) parts.push(`第 ${request.episodeNumber} 集`);
    if (typeof preview?.segmentIndex === "number") parts.push(`第 ${preview.segmentIndex + 1} 段`);
    else if (request.segmentTitle) parts.push(request.segmentTitle);
    return parts.join(" · ");
}

/** 图片视频直接提交；文字保留确认，其余弹窗展示阻断或异常结果。 */
export function DramaMediaActionDialog({ controller }: { controller: DramaMediaActionController }) {
    const { state } = controller;
    const preview = state.preview;
    const action = preview?.action || state.request?.action;
    const reprocessing = action === "segment_reprocess";
    const textAction = action === "segment_prompt";
    const busy = state.loading || state.submitting;
    const missing = preview?.missingCasts ?? [];
    const canSwitchToAssets = action === "segment_video" && missing.length > 0 && !state.submitted;
    const canRecheckVideo = Boolean(state.pendingVideo && state.submitted && action === "segment_assets");
    const assetRequest: DramaMediaActionTarget | null = canSwitchToAssets && state.request ? { ...state.request, action: "segment_assets", baseRevision: undefined, targetRevision: undefined, confirmationToken: undefined } : null;
    const assetQuote = useDramaMediaQuote(controller, assetRequest, preview?.baseRevision);
    useDramaMediaQuote(controller, textAction && state.open ? state.request : null, preview?.baseRevision);
    const canConfirmText = Boolean(preview?.ready && preview.confirmationToken && !state.submitted && !state.error && !busy);

    return (
        <AppModal
            open={state.open}
            centered
            width={480}
            title={textAction ? (state.submitted ? "已提交提示词撰写" : "确认撰写提示词") : state.submitted ? "请核对制作队列" : state.error ? "暂时无法生成" : "生成条件尚未满足"}
            footer={
                <>
                    <Button onClick={controller.close}>{textAction && !state.submitted ? "取消" : "关闭"}</Button>
                    {textAction && !state.submitted ? (
                        <Button type="primary" loading={state.submitting} disabled={!canConfirmText} onClick={() => void controller.confirm()}>
                            确认提交
                        </Button>
                    ) : null}
                </>
            }
            onCancel={() => controller.close()}
        >
            <div className="flex flex-col gap-2 text-sm" aria-live="polite">
                {state.request ? <p>{scopeLabel(controller)}</p> : null}
                {preview ? <p>{preview.message}</p> : null}
                {preview && reprocessing ? (
                    <p>本次 0 积分</p>
                ) : preview?.priced ? (
                    <p>
                        {textAction ? "预计 " : ""}
                        {formatDramaCredits(preview.amountMicrocredits)} 积分
                    </p>
                ) : textAction && preview ? (
                    <p role="status">暂无法估算费用，以实际扣费为准</p>
                ) : null}
                {preview?.reason ? (
                    <p role="status">
                        {action === "segment_video" && missing.length ? "还不能生成视频：" : ""}
                        {preview.reason}
                    </p>
                ) : null}
                {preview?.warnings.map((warning) => (
                    <p key={warning} role="status">
                        {warning}
                    </p>
                ))}
                {action === "cast_image" && state.projectId && state.castImpact ? <CastVideoImpact projectId={state.projectId} impact={state.castImpact} restyleSegments={false} /> : null}
                {missing.length ? (
                    <div>
                        <p>缺少这些参考图：</p>
                        <ul>
                            {missing.map((cast) => (
                                <li key={cast.id}>{cast.name}</li>
                            ))}
                        </ul>
                    </div>
                ) : null}
                {state.loading ? <p role="status">{reprocessing ? "正在检查已有视频与处理条件…" : "正在检查当前对象与生成条件…"}</p> : null}
                {state.error ? (
                    <p role="alert">
                        {state.error}
                        {!state.submitted ? (
                            <Button type="link" size="small" disabled={busy} onClick={controller.retry}>
                                重新读取生成条件
                            </Button>
                        ) : null}
                    </p>
                ) : null}
                {state.notice ? <p role="status">{state.notice}</p> : null}
                {state.submitted && state.queued > 0 ? (
                    <p role="status">
                        {reprocessing ? `已提交 ${state.queued} 项视频重新处理` : `已提交 ${state.queued} 个任务`}，可在下方制作队列查看进度。
                        {action === "segment_assets" && state.pendingVideo ? " 参考图就绪后，再点击生成视频。" : ""}
                    </p>
                ) : null}
                {!state.submitted && !state.loading && !state.error ? (
                    <Button disabled={busy} onClick={() => controller.retry()}>
                        重新检查
                    </Button>
                ) : null}
                {canSwitchToAssets ? (
                    <Button type="default" disabled={busy || assetQuote.disabled} loading={assetQuote.submitting} onClick={controller.requestMissingAssets}>
                        {generationLabel("生成缺失参考图", assetQuote.preview, assetQuote.loading)}
                    </Button>
                ) : null}
                {canRecheckVideo ? (
                    <Button type="default" disabled={busy} onClick={() => void controller.recheckVideo()}>
                        重新检查本段视频
                    </Button>
                ) : null}
            </div>
        </AppModal>
    );
}
