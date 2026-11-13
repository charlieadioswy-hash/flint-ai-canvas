import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { App, Button } from "antd";
import { Check, Clapperboard, Loader2, Play, RefreshCw } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { renderDramaEpisode, type DramaEpisodeDetail, type DramaEpisodeRow } from "@/services/api/drama";

import { downloadResource, formatDuration, useResourceMediaUrl } from "./drama-shared";
import { JianyingDraftModal } from "./studio/asset-transfer";
import { secondsLabel } from "./studio/segment-parts";

export function SimpleEpisodeFinalCard({
    projectId,
    title,
    episode,
    detail,
    unavailable,
    blockingReason,
    onChanged,
}: {
    projectId: string;
    title: string;
    episode: DramaEpisodeRow;
    detail?: DramaEpisodeDetail;
    unavailable: boolean;
    blockingReason?: string;
    onChanged: () => void | Promise<unknown>;
}) {
    const { message } = App.useApp();
    const [playing, setPlaying] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const submitting = useRef(false);
    const segments = detail?.segments || [];
    const current = detail?.episode;
    const resourceId = current?.finalResourceId;
    const url = useResourceMediaUrl(resourceId, "playback");
    const ready = segments.filter((segment) => segment.videoStatus === "ready" && segment.videoResourceId && (segment.videoSeconds || 0) > 0).length;
    const renderJob = detail?.jobs.find((job) => job.kind === "render" && (job.status === "queued" || job.status === "running"));
    const awaitingSubmission = renderJob?.status === "queued" && !renderJob.taskId;
    const renderError = episode.stage === "render" ? episode.error || current?.error : "";
    const stale = Boolean(resourceId && (episode.finalStale || current?.finalStale));
    const mutation = useMutation({
        mutationFn: () => renderDramaEpisode(projectId, episode.id, { expectedRevision: current!.revision }),
        onSuccess: async (result) => {
            message.success(result.jobs > 0 ? "已提交本集视频合成，可在下方队列查看进度" : "本集已有合成任务或成片，已刷新最新状态");
            await onChanged();
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "本集视频合成失败"),
    });
    const rendering = mutation.isPending || Boolean(renderJob && !awaitingSubmission) || (episode.stage === "render" && !renderError && !awaitingSubmission);
    const blocked = unavailable ? "最新内容读取失败，请刷新后合成" : blockingReason || (!current ? "正在读取本集视频" : !segments.length ? "本集还没有剧情段" : ready !== segments.length ? `还有 ${segments.length - ready} 段视频未就绪或需要更新` : "");
    const status = rendering ? (renderJob?.status === "running" ? "正在合成" : "合成排队中") : awaitingSubmission ? "等待提交合成" : renderError ? "合成失败" : stale ? "成片待更新" : resourceId ? "成片已就绪" : "待合成";
    const tone = rendering ? "busy" : awaitingSubmission ? "blocked" : renderError ? "failed" : stale ? "stale" : resourceId ? "ready" : "idle";
    const compose = () => {
        if (blocked || rendering || submitting.current) return;
        submitting.current = true;
        void mutation
            .mutateAsync()
            .catch(() => undefined)
            .finally(() => {
                submitting.current = false;
            });
    };
    const download = async () => {
        if (!resourceId || downloading) return;
        setDownloading(true);
        try {
            await downloadResource(resourceId, `${title}-第${episode.number}集.mp4`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        } finally {
            setDownloading(false);
        }
    };
    return (
        <article className="drama-simple-card drama-simple-final" data-episode-final-id={episode.id}>
            <button className="drama-simple-cover" type="button" disabled={!url} onClick={() => setPlaying(true)} aria-label={`播放第 ${episode.number} 集成片`}>
                {url ? (
                    <video key={url} src={`${url}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden />
                ) : (
                    <span className="drama-simple-cover-empty">
                        <Clapperboard className="size-6" />
                        <span>{rendering ? status : "本集成片"}</span>
                    </span>
                )}
                <span className="drama-simple-duration">{secondsLabel(current?.durationMs || episode.durationMs)}</span>
                {url ? (
                    <span className="drama-simple-edit">
                        <Play className="size-3" />
                        播放成片
                    </span>
                ) : null}
            </button>
            <button
                className="drama-simple-card-copy drama-simple-final-compose"
                type="button"
                aria-label={`合成第 ${episode.number} 集视频`}
                title={blocked || renderError || "仅拼接本集已有视频，不重新生成剧情段"}
                disabled={Boolean(blocked) || rendering}
                onClick={compose}
            >
                <strong>
                    {rendering ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <RefreshCw className="size-3.5" />}
                    {rendering ? status : awaitingSubmission ? "继续合成本集" : renderError ? "重试合成本集" : resourceId ? "重新合成本集" : "合成本集视频"}
                </strong>
                <p>
                    {formatDuration(current?.durationMs || episode.durationMs)} · {segments.length} 个剧情段 · 对白与音效来自视频模型
                </p>
            </button>
            <div className="drama-simple-card-state" role="status">
                <span className={`drama-sg-status is-${tone}`} title={renderError || undefined}>
                    {rendering ? <Loader2 className="size-3 motion-safe:animate-spin" /> : resourceId && !stale && !renderError ? <Check className="size-3" /> : <i />}
                    {status}
                </span>
                <span title={blocked || (stale ? "内容已修改，当前成片是修改前的版本" : "合成只使用当前已采用的段视频")}>{blocked || (stale ? "当前为旧版成片" : `${ready}/${segments.length} 段就绪`)}</span>
            </div>
            <footer>
                <Button size="small" disabled={!resourceId} loading={downloading} aria-label={`下载第 ${episode.number} 集成片`} onClick={() => void download()}>
                    下载成片
                </Button>
                <Button size="small" disabled={!segments.length} aria-label={`导出第 ${episode.number} 集剪映草稿`} onClick={() => setExporting(true)}>
                    导出剪映草稿
                </Button>
            </footer>
            {playing && url ? (
                <AppModal open onCancel={() => setPlaying(false)} footer={null} title={`第 ${episode.number} 集 · ${episode.title}`} centered width="min(960px, calc(100vw - 32px))" rootClassName="drama-root">
                    <video className="drama-simple-final-player" key={url} src={url} controls autoPlay playsInline preload="metadata" />
                </AppModal>
            ) : null}
            {exporting ? <JianyingDraftModal open projectId={projectId} episodeId={episode.id} episodeLabel={`第 ${episode.number} 集`} onClose={() => setExporting(false)} /> : null}
        </article>
    );
}
