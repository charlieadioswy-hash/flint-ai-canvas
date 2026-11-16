import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button } from "antd";
import { Clapperboard, Image, Pencil, Play, Plus, RefreshCw } from "lucide-react";

import { insertDramaShot, type DramaCast, type DramaEpisodeDetail, type DramaSegment, type DramaShot, type DramaSummary } from "@/services/api/drama";
import { getDramaShotMedia, type DramaShotMedia } from "@/services/api/drama-shot-media";
import { useUserStore } from "@/stores/use-user-store";

import { MediaThumb, mediaBusy, useResourceMediaUrl } from "./drama-shared";
import { SegmentStatus, SegmentVideo, secondsLabel, segmentState } from "./studio/segment-parts";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { QuotedMediaButton } from "./studio/drama-media-action-context";
import { dramaVideoAction } from "./studio/drama-media-action-request";
import { WorkflowSceneSplits } from "./workflow-scene-splits";
import { WorkflowStoryboardDialog } from "./workflow-storyboard-dialog";
import "./workflow-storyboard-page.css";

type Props = {
    summary: DramaSummary;
    detail: DramaEpisodeDetail;
    castById: Map<string, DramaCast>;
    status: string;
    videoAllowed: boolean;
    segmentIndex?: number;
    onSegmentChange?: (index: number) => void;
    onOpenSegment: (index: number) => void;
    onGenerateSegment: (segment: DramaSegment) => void;
    onWriteSegmentPrompt: (segment: DramaSegment) => void;
    selectedSegmentIds: ReadonlySet<string>;
    onSelectSegments: (ids: string[], checked: boolean) => void;
    onChanged: () => void;
    onOpenShot: (shot: DramaShot, kind?: "image" | "video" | "audio") => void;
    onEditShot: (shot: DramaShot) => void;
    onOpenCast: (id: string) => void;
};

const MEDIA_STATE: Record<string, string> = { idle: "待生成", ready: "已就绪", succeeded: "已就绪", queued: "排队中", running: "生成中", failed: "生成失败", cancelled: "已取消", stale: "待更新" };

export function WorkflowStoryboardPage({
    summary,
    detail,
    castById,
    status,
    videoAllowed,
    segmentIndex,
    onSegmentChange,
    onOpenSegment,
    onGenerateSegment,
    onWriteSegmentPrompt,
    selectedSegmentIds,
    onSelectSegments,
    onChanged,
    onOpenShot,
    onEditShot,
    onOpenCast,
}: Props) {
    const { message } = App.useApp();
    const operation = useDramaOperationScope(summary.project.id);
    const segments = detail.segments.toSorted((left, right) => left.index - right.index);
    const phase = videoAllowed ? "video" : "prompt";
    const visibleSegments = segments.filter((item) => status === "all" || segmentState(item, phase).tone === status);
    const [selectedSegmentId, setSelectedSegmentId] = useState("");
    const [collapsed, setCollapsed] = useState(false);
    const [board, setBoard] = useState<{ projectId: string; episodeId: string; shots: DramaShot[]; title: string }>();
    const boardOpen = Boolean(board && board.projectId === summary.project.id && board.episodeId === detail.episode.id);
    const [previewSegmentId, setPreviewSegmentId] = useState<string>();
    const mode = summary.production.settings.storyboard.generationMode || "reference_video";
    const boardLabel = mode === "grid_image" ? "生成宫格图" : "生成故事板";
    const defaultKind = mode === "grid_image" || mode === "storyboard" ? "image" : "video";
    const segment = visibleSegments.find((item) => (segmentIndex === undefined ? item.id === selectedSegmentId : item.index === segmentIndex)) || visibleSegments[0];
    const shots = segment ? detail.shots.filter((shot) => shot.segmentIndex === segment.index) : [];
    const first = shots[0];
    const activeSegment = useRef(segment?.id);
    activeSegment.current = segment?.id;
    const insertLock = useRef(false);
    const insert = useMutation({
        mutationFn: ({ anchor, ticket }: { anchor: DramaShot; ticket: ReturnType<typeof operation.capture>; segmentId: string }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或账号已切换，请重新操作");
            return insertDramaShot(summary.project.id, anchor.id, "after");
        },
        onSuccess: ({ shot }, { ticket, segmentId }) => {
            if (!operation.isCurrent(ticket)) return;
            onChanged();
            if (activeSegment.current === segmentId) onEditShot(shot);
        },
        onError: (error, { ticket }) => {
            if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "新增镜头失败");
        },
        onSettled: () => {
            insertLock.current = false;
        },
    });

    if (!segments.length) return <p role="status">本集暂无剧情段，请先完成剧本与分镜。</p>;
    const generating = Boolean(segment && mediaBusy(segment.videoStatus));
    const writing = segment?.promptStatus === "queued" || segment?.promptStatus === "running";
    const currentBusy = insert.isPending || writing || generating;
    const videoLabel = generating ? "生成中" : segment?.videoReprocessable ? "重试本段后处理" : segment?.videoStatus === "failed" ? "重试本段视频" : segment?.videoResourceId ? "重新生成本段视频" : "生成本段视频";
    return (
        <div className="drama-storyboard-page">
            <nav className="drama-storyboard-segments thin-scrollbar" aria-label={`第 ${detail.episode.number} 集段列表`}>
                <header>
                    <strong>共 {segments.length} 段</strong>
                    <span>{detail.shots.length} 镜</span>
                </header>
                <label className="drama-storyboard-segment-select-all">
                    <input
                        type="checkbox"
                        aria-label={`选择第 ${detail.episode.number} 集筛选出的 ${visibleSegments.length} 段`}
                        checked={Boolean(visibleSegments.length && visibleSegments.every((item) => selectedSegmentIds.has(item.id)))}
                        disabled={!visibleSegments.length}
                        onChange={(event) =>
                            onSelectSegments(
                                visibleSegments.map((item) => item.id),
                                event.target.checked,
                            )
                        }
                    />
                    选择当前列表
                </label>
                {visibleSegments.map((item) => (
                    <div key={item.id} className="drama-storyboard-segment-row" data-selected={item.id === segment?.id}>
                        <input type="checkbox" aria-label={`选择第 ${detail.episode.number} 集第 ${item.index + 1} 段`} checked={selectedSegmentIds.has(item.id)} onChange={(event) => onSelectSegments([item.id], event.target.checked)} />
                        <button
                            type="button"
                            aria-pressed={item.id === segment?.id}
                            aria-label={`查看第 ${item.index + 1} 段${item.title ? `：${item.title}` : ""}`}
                            disabled={insert.isPending || boardOpen}
                            onClick={() => {
                                setSelectedSegmentId(item.id);
                                onSegmentChange?.(item.index);
                                setCollapsed(false);
                                setPreviewSegmentId(undefined);
                            }}
                        >
                            <span>
                                <strong>
                                    第 {item.index + 1} 段{item.title ? ` · ${item.title}` : ""}
                                </strong>
                                <small>
                                    {detail.shots.filter((shot) => shot.segmentIndex === item.index).length} 镜 · {secondsLabel(item.durationMs)}
                                </small>
                                <SegmentStatus segment={item} phase={phase} />
                            </span>
                        </button>
                    </div>
                ))}
                {!visibleSegments.length ? (
                    <p className="drama-storyboard-filter-note" role="status">
                        没有符合筛选条件的段
                    </p>
                ) : null}
            </nav>
            <section className="drama-storyboard-segment" aria-label={segment ? `第 ${segment.index + 1} 段分镜` : undefined}>
                <header className="drama-storyboard-segment-toolbar" hidden={!segment}>
                    {segment ? (
                        <div>
                            <h4>
                                第 {segment.index + 1} 段{segment.title ? ` · ${segment.title}` : ""}{" "}
                                <span>
                                    {shots.length} 镜 · {secondsLabel(segment.durationMs)}
                                </span>
                            </h4>
                            <SegmentStatus segment={segment} phase={phase} />
                        </div>
                    ) : null}
                    <div className="drama-storyboard-segment-actions">
                        {segment ? (
                            <>
                                <div className="drama-storyboard-action-group" role="group" aria-label="本段制作">
                                    <span>制作</span>
                                    <Button size="small" icon={<RefreshCw className="size-4" />} disabled={currentBusy} onClick={() => onWriteSegmentPrompt(segment)}>
                                        {writing ? "撰写中" : segment.promptStatus === "failed" ? "重试本段提示词" : "撰写本段提示词"}
                                    </Button>
                                    <QuotedMediaButton
                                        size="small"
                                        icon={<Play className="size-4" />}
                                        disabled={currentBusy || !videoAllowed}
                                        title={!videoAllowed ? "请先确认文字与提示词" : undefined}
                                        request={segment.videoReprocessable ? { ...dramaVideoAction(detail.episode, segment), action: "segment_reprocess" } : dramaVideoAction(detail.episode, segment)}
                                        label={videoLabel}
                                        onClick={() => onGenerateSegment(segment)}
                                    />
                                    <Button size="small" icon={<Play className="size-4" />} aria-expanded={previewSegmentId === segment.id} onClick={() => setPreviewSegmentId(previewSegmentId === segment.id ? undefined : segment.id)}>
                                        预览本段
                                    </Button>
                                </div>
                                <div className="drama-storyboard-action-group" role="group" aria-label="本段调整">
                                    <span>调整</span>
                                    <Button size="small" icon={<Pencil className="size-4" />} onClick={() => onOpenSegment(segment.index)}>
                                        编辑本段
                                    </Button>
                                    <Button
                                        size="small"
                                        icon={<Plus className="size-4" />}
                                        loading={insert.isPending}
                                        disabled={!first}
                                        onClick={() => {
                                            const anchor = shots.at(-1);
                                            if (!anchor || insertLock.current) return;
                                            insertLock.current = true;
                                            insert.mutate({ anchor, ticket: operation.capture(), segmentId: segment.id });
                                        }}
                                    >
                                        新增镜头
                                    </Button>
                                    <Button
                                        size="small"
                                        disabled={!shots.length}
                                        onClick={() => setBoard({ projectId: summary.project.id, episodeId: detail.episode.id, shots: shots.map((shot) => ({ ...shot })), title: mode === "grid_image" ? "宫格图" : "故事板" })}
                                    >
                                        {boardLabel}
                                    </Button>
                                    <WorkflowSceneSplits summary={summary} detail={detail} initialSegmentIndex={segment.index} buttonLabel="重拆本段" onChanged={onChanged} onOpenSegment={onOpenSegment} />
                                </div>
                                <div className="drama-storyboard-action-group" role="group" aria-label="本段视图">
                                    <span>视图</span>
                                    <Button size="small" type="text" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
                                        {collapsed ? "展开" : "收起"}
                                    </Button>
                                </div>
                            </>
                        ) : null}
                    </div>
                </header>
                {segment && previewSegmentId === segment.id ? (
                    <section className="drama-storyboard-segment-preview" aria-label={`第 ${segment.index + 1} 段视频预览`}>
                        <SegmentVideo segment={segment} aspectRatio={summary.production.settings.aspectRatio} />
                    </section>
                ) : null}
                {segment && (segment.videoError || segment.promptError) ? (
                    <p className="drama-storyboard-shot-error" role="status">
                        {segment.promptError || segment.videoError}
                    </p>
                ) : null}
                {segment && !collapsed ? (
                    <div className="drama-storyboard-shots-grid">
                        {shots.map((shot) => (
                            <StoryboardShotCard key={shot.id} shot={shot} castById={castById} videoAllowed={videoAllowed} defaultKind={defaultKind} onOpen={(kind) => onOpenShot(shot, kind)} onEdit={() => onEditShot(shot)} onOpenCast={onOpenCast} />
                        ))}
                    </div>
                ) : null}
                {segment && !collapsed && !shots.length ? <p role="status">本段暂无镜头，请编辑本段或重新拆分。</p> : null}
                {!segment ? <p role="status">切换“全部状态”查看本集剧情段。</p> : null}
            </section>
            <WorkflowStoryboardDialog
                open={boardOpen}
                projectId={summary.project.id}
                shots={board?.shots || []}
                title={board?.title || boardLabel}
                onClose={() => {
                    setBoard(undefined);
                    onChanged();
                }}
            />
        </div>
    );
}

function castIds(shot: DramaShot) {
    const ids: string[] = [];
    for (const value of [shot.castIdsJson, shot.lookCastIdsJson, shot.propIdsJson]) {
        try {
            const parsed: unknown = JSON.parse(value || "[]");
            if (Array.isArray(parsed)) ids.push(...parsed.filter((id): id is string => typeof id === "string"));
        } catch {
            /* Older shots may not have references. */
        }
    }
    if (shot.sceneCastId) ids.push(shot.sceneCastId);
    return [...new Set(ids)];
}

function shotTone(video?: DramaShotMedia, allowed = true) {
    if (video?.status === "failed") return "failed";
    if (video?.status === "queued" || video?.status === "running") return "busy";
    if (video?.status === "stale") return "stale";
    if (video?.resourceId && ["ready", "succeeded"].includes(video.status)) return "ready";
    return allowed ? "idle" : "blocked";
}

function StoryboardShotCard({
    shot,
    castById,
    videoAllowed,
    defaultKind,
    onOpen,
    onEdit,
    onOpenCast,
}: {
    shot: DramaShot;
    castById: Map<string, DramaCast>;
    videoAllowed: boolean;
    defaultKind: "image" | "video";
    onOpen: (kind?: "image" | "video" | "audio") => void;
    onEdit: () => void;
    onOpenCast: (id: string) => void;
}) {
    const userId = useUserStore((state) => state.user?.id || "");
    const image = useQuery({
        queryKey: ["drama-shot-media", userId, shot.projectId, shot.id, "image"],
        queryFn: ({ signal }) => getDramaShotMedia(shot.projectId, shot.id, "image", signal),
        staleTime: 20_000,
        refetchInterval: (query) => (["queued", "running"].includes(query.state.data?.status || "") ? 3000 : false),
    });
    const video = useQuery({
        queryKey: ["drama-shot-media", userId, shot.projectId, shot.id, "video"],
        queryFn: ({ signal }) => getDramaShotMedia(shot.projectId, shot.id, "video", signal),
        staleTime: 20_000,
        refetchInterval: (query) => (["queued", "running"].includes(query.state.data?.status || "") ? 3000 : false),
    });
    const videoUrl = useResourceMediaUrl(video.data?.resourceId, "playback");
    const tone = shotTone(video.data, videoAllowed);
    const subjects = castIds(shot).flatMap((id) => {
        const cast = castById.get(id);
        return cast ? [cast] : [];
    });
    const visibleSubjects = subjects.length > 6 ? subjects.slice(0, 5) : subjects;
    const overflowSubjects = subjects.slice(visibleSubjects.length);
    const overflowSubjectLabel = `另有 ${overflowSubjects.length} 个主体：${overflowSubjects.map((cast) => cast.name).join("、")}`;
    return (
        <article className="drama-storyboard-shot" data-tone={tone}>
            <button className="drama-storyboard-shot-cover" type="button" aria-label={`编辑分镜 ${shot.position + 1} 的媒体`} onClick={() => onOpen(video.data?.resourceId ? "video" : defaultKind)}>
                {image.data?.resourceId ? (
                    <MediaThumb resourceId={image.data.resourceId} alt={`分镜 ${shot.position + 1}`} />
                ) : videoUrl ? (
                    <video src={videoUrl} muted preload="metadata" playsInline />
                ) : (
                    <span>
                        <Clapperboard className="size-7" />
                        {defaultKind === "video" ? "生成视频" : "生成图片"}
                    </span>
                )}
                <span className="drama-storyboard-shot-time">{(shot.durationMs / 1000).toFixed(1)}s</span>
                <span className="drama-storyboard-shot-open">
                    <Pencil className="size-3" />
                    编辑媒体
                </span>
            </button>
            <div className="drama-storyboard-shot-content">
                <header>
                    <h5>分镜 {shot.position + 1}</h5>
                    <span className="drama-storyboard-shot-state">{MEDIA_STATE[video.data?.status || "idle"] || video.data?.status}</span>
                </header>
                <p className="drama-storyboard-shot-description">
                    <span>【镜头语言】</span>
                    {[shot.shotSize, shot.camera].filter(Boolean).join("。")}。<span>【场景与氛围】</span>
                    {shot.scene || "待补充"}。<span>【主体与画面】</span>
                    {shot.action || shot.imagePrompt || "点击铅笔补充画面描述"}
                    {shot.dialogue ? (
                        <>
                            {" "}
                            <span>【{shot.speaker || "对白"}】</span>
                            {shot.dialogue}
                        </>
                    ) : null}
                </p>
                {subjects.length ? (
                    <section className="drama-storyboard-shot-subjects" aria-label="镜头主体">
                        <strong>主体</strong>
                        <div>
                            {visibleSubjects.map((cast) => (
                                <button type="button" key={cast.id} title={cast.name} onClick={() => onOpenCast(cast.id)}>
                                    {cast.imageResourceId ? <MediaThumb resourceId={cast.imageResourceId} alt="" /> : null}
                                    <span>{cast.name}</span>
                                </button>
                            ))}
                            {overflowSubjects.length ? (
                                <span className="drama-storyboard-shot-subject-overflow" title={overflowSubjectLabel}>
                                    <span aria-hidden>....</span>
                                    <span className="sr-only">{overflowSubjectLabel}</span>
                                </span>
                            ) : null}
                        </div>
                    </section>
                ) : null}
                {image.isError || video.isError ? (
                    <p className="drama-storyboard-shot-error" role="status">
                        媒体状态读取失败，可打开镜头重试
                    </p>
                ) : null}
            </div>
            <footer>
                <Button type="text" size="small" aria-label={`分镜 ${shot.position + 1} 图片 · ${MEDIA_STATE[image.data?.status || "idle"] || image.data?.status}`} title="编辑图片" icon={<Image className="size-3.5" />} onClick={() => onOpen("image")} />
                <Button type="text" size="small" aria-label={`分镜 ${shot.position + 1} 视频 · ${MEDIA_STATE[video.data?.status || "idle"] || video.data?.status}`} title="编辑视频" icon={<Play className="size-3.5" />} onClick={() => onOpen("video")} />
                <Button className="drama-storyboard-shot-edit" type="text" size="small" aria-label={`编辑分镜 ${shot.position + 1} 文字`} icon={<Pencil className="size-3.5" />} onClick={onEdit}>
                    编辑分镜
                </Button>
            </footer>
        </article>
    );
}
