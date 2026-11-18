import { Button } from "antd";
import { Clapperboard, Film, Pencil, Play, RefreshCw } from "lucide-react";

import type { DramaSegment, DramaShot } from "@/services/api/drama";

import { MediaThumb, mediaBusy, useResourceMediaUrl } from "./drama-shared";
import { SegmentStatus, secondsLabel } from "./studio/segment-parts";
import { displaySegmentPrompt } from "@/lib/drama/segment-prompt";
import { QuotedMediaButton } from "./studio/drama-media-action-context";

function VideoCover({ resourceId }: { resourceId: string }) {
    const url = useResourceMediaUrl(resourceId, "playback");
    return url ? <video src={`${url}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden /> : <Film className="size-6" />;
}

export function segmentCopy(segment: DramaSegment, shots: DramaShot[]) {
    const spoken = shots
        .map((shot) => (shot.dialogue ? `${shot.speaker || "旁白"}：${shot.dialogue}` : shot.action || shot.imagePrompt))
        .filter(Boolean)
        .join(" ");
    return spoken || displaySegmentPrompt(segment, segment.videoPrompt).trim() || "打开分镜，补充画面与台词";
}

export function segmentPromptText(segment: DramaSegment) {
    return displaySegmentPrompt(segment, segment.videoPrompt.trim() || segment.generated.trim());
}

/** 分镜卡片只展示服务端已有的段、镜头和视频，不生成演示画面。 */
export function WorkflowSegmentCard({
    episodeNumber,
    segment,
    shots,
    textConfirmed,
    onOpen,
    onGenerate,
    onWritePrompt,
}: {
    episodeNumber: number;
    segment: DramaSegment;
    shots: DramaShot[];
    textConfirmed: boolean;
    onOpen: () => void;
    onGenerate: () => void;
    onWritePrompt: () => void;
}) {
    const description = segmentCopy(segment, shots);
    const prompt = segmentPromptText(segment);
    const generating = mediaBusy(segment.videoStatus);
    const writing = segment.promptStatus === "queued" || segment.promptStatus === "running";
    const title = segment.title || shots[0]?.scene || "未命名场景";
    const label = `第 ${episodeNumber} 集第 ${segment.index + 1} 段`;
    const videoLabel = generating ? "生成中" : segment.videoReprocessable ? "重新处理" : segment.videoResourceId ? "重新生成" : "生成视频";
    const videoTitle = textConfirmed ? undefined : "需要先确认文字";
    return (
        <article className="drama-workflow-segment" data-segment-id={segment.id}>
            <button className="drama-workflow-segment-cover" type="button" onClick={onOpen} aria-label={`编辑${label}：${title}`}>
                {segment.tailFrameResourceId ? (
                    <MediaThumb resourceId={segment.tailFrameResourceId} alt={segment.title || title} fallback={<Film className="size-6" />} />
                ) : segment.videoResourceId ? (
                    <VideoCover resourceId={segment.videoResourceId} />
                ) : (
                    <span className="drama-workflow-segment-empty">
                        <Clapperboard className="size-6" />
                        <span>{generating ? "视频生成中" : "待生成画面"}</span>
                    </span>
                )}
                <span className="drama-workflow-segment-duration">{secondsLabel(segment.durationMs)}</span>
                <span className="drama-workflow-segment-edit">
                    <Pencil className="size-3" />
                    编辑
                </span>
            </button>
            <button className="drama-workflow-segment-copy" type="button" onClick={onOpen}>
                <strong>
                    第 {segment.index + 1} 段 · {title}
                </strong>
                <p title={description}>{description}</p>
            </button>
            {prompt ? (
                <p className="drama-workflow-segment-prompt" title={prompt}>
                    {prompt}
                </p>
            ) : (
                <p className="drama-workflow-segment-prompt is-empty">还没有视频提示词</p>
            )}
            <div className="drama-workflow-segment-state">
                <SegmentStatus segment={segment} phase={textConfirmed ? "video" : "prompt"} />
                <span>{shots.length} 镜</span>
            </div>
            <footer>
                <Button size="small" icon={<RefreshCw className="size-3" />} disabled={writing || generating} aria-label={`重新撰写${label}提示词`} onClick={onWritePrompt}>
                    {writing ? "撰写中" : prompt ? "重新撰写" : "撰写提示词"}
                </Button>
                <QuotedMediaButton
                    size="small"
                    icon={<Play className="size-3" />}
                    disabled={generating || writing || !textConfirmed}
                    title={videoTitle}
                    aria-label={`${videoLabel}${label}`}
                    request={{ action: segment.videoReprocessable ? "segment_reprocess" : "segment_video", targetId: segment.id, episodeId: shots[0]?.episodeId, targetRevision: segment.revision }}
                    label={videoLabel}
                    onClick={onGenerate}
                />
            </footer>
        </article>
    );
}
