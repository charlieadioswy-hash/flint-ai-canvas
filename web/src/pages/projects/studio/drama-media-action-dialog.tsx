import { Button } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import type { DramaStudioAction } from "@/services/api/drama";
import { CastVideoImpact } from "../workflow-impact";
import type { DramaMediaActionController } from "./use-drama-media-action";

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

/** 确认弹窗只展示服务端预检结果；任务进度由父级制作队列负责，这里不是实时队列。 */
export function DramaMediaActionDialog({ controller }: { controller: DramaMediaActionController }) {
    const { state } = controller;
    const preview = state.preview;
    const action = preview?.action || state.request?.action;
    const reprocessing = action === "segment_reprocess";
    const busy = state.loading || state.submitting;
    const canConfirm = Boolean(preview?.ready && preview.confirmationToken && !state.submitted && !state.error && (action !== "cast_image" || state.castImpact));
    const missing = preview?.missingCasts ?? [];
    const canSwitchToAssets = action === "segment_video" && missing.length > 0 && !state.submitted;
    const canRecheckVideo = Boolean(state.pendingVideo && state.submitted && action === "segment_assets");

    return (
        <AppModal
            open={state.open}
            centered
            width={480}
            title={state.submitted ? (state.queued > 0 ? (reprocessing ? "已提交重新处理" : "已提交") : "请核对队列") : reprocessing ? "确认重新处理已有视频" : "确认生成"}
            okText={state.submitted ? "关闭" : "确认提交"}
            cancelText={state.submitted ? "关闭" : "取消"}
            okButtonProps={{ disabled: state.submitted ? false : !canConfirm || busy }}
            confirmLoading={state.submitting}
            onOk={() => {
                if (state.submitted) controller.close();
                else void controller.confirm();
            }}
            onCancel={() => controller.close()}
        >
            <div className="flex flex-col gap-2 text-sm" aria-live="polite">
                {state.request ? <p>{scopeLabel(controller)}</p> : null}
                {preview ? <p>{preview.message}</p> : null}
                {preview && reprocessing ? <p>本次 0 积分</p> : preview?.priced ? <p>预计 {formatDramaCredits(preview.amountMicrocredits)} 积分</p> : preview ? <p role="status">暂无法估算费用，以实际扣费为准</p> : null}
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
                        <Button type="link" size="small" disabled={busy} onClick={() => void controller.retry()}>
                            重试
                        </Button>
                    </p>
                ) : null}
                {state.notice ? <p role="status">{state.notice}</p> : null}
                {state.submitted && state.queued > 0 ? (
                    <p role="status">
                        {reprocessing ? `已提交 ${state.queued} 项视频重新处理` : `已提交 ${state.queued} 个任务`}，可在下方制作队列查看进度。
                        {action === "segment_assets" && state.pendingVideo ? " 视频还没有提交，需要你再单独确认一次。" : ""}
                    </p>
                ) : null}
                {!state.submitted && !state.loading && !state.error ? (
                    <Button disabled={busy} onClick={() => controller.retry()}>
                        重新检查
                    </Button>
                ) : null}
                {canSwitchToAssets ? (
                    <Button type="default" disabled={busy} onClick={() => void controller.requestMissingAssets()}>
                        只生成缺失的参考图
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
