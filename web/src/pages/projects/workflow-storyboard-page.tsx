import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button } from "antd";
import { Clapperboard, Image, Pencil, Play, Plus } from "lucide-react";

import { dramaSceneGroups } from "@/lib/drama/director";
import { insertDramaShot, type DramaCast, type DramaEpisodeDetail, type DramaShot, type DramaSummary } from "@/services/api/drama";
import { getDramaShotMedia, type DramaShotMedia } from "@/services/api/drama-shot-media";
import { useUserStore } from "@/stores/use-user-store";

import { MediaThumb, useResourceMediaUrl } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { WorkflowSceneSplits } from "./workflow-scene-splits";
import { WorkflowStoryboardDialog } from "./workflow-storyboard-dialog";
import { WorkflowBatch } from "./workflow-batch";
import "./workflow-storyboard-page.css";

type Props = {
    summary: DramaSummary;
    detail: DramaEpisodeDetail;
    castById: Map<string, DramaCast>;
    status: string;
    videoAllowed: boolean;
    onChanged: () => void;
    onOpenShot: (shot: DramaShot, kind?: "image" | "video" | "audio") => void;
    onEditShot: (shot: DramaShot) => void;
    onOpenCast: (id: string) => void;
};

const MEDIA_STATE: Record<string, string> = { idle: "待生成", ready: "已就绪", succeeded: "已就绪", queued: "排队中", running: "生成中", failed: "生成失败", cancelled: "已取消", stale: "待更新" };

export function WorkflowStoryboardPage({ summary, detail, castById, status, videoAllowed, onChanged, onOpenShot, onEditShot, onOpenCast }: Props) {
    const { message } = App.useApp();
    const operation = useDramaOperationScope(summary.project.id);
    const groups = dramaSceneGroups(detail.shots);
    const [selectedAct, setSelectedAct] = useState("");
    const [collapsed, setCollapsed] = useState(false);
    const [boardOpen, setBoardOpen] = useState(false);
    const mode = summary.production.settings.storyboard.generationMode || "reference_video";
    const boardLabel = mode === "grid_image" ? "生成宫格图" : "生成故事板";
    const defaultKind = mode === "grid_image" || mode === "storyboard" ? "image" : "video";
    const actIndex = Math.max(
        0,
        groups.findIndex((rows) => rows[0].id === selectedAct),
    );
    const shots = groups[actIndex] || [];
    const first = shots[0];
    const activeAct = useRef(first?.id);
    activeAct.current = first?.id;
    const insertLock = useRef(false);
    const actSegments = detail.segments.filter((segment) => shots.some((shot) => shot.segmentIndex === segment.index));
    const batchScope = `当前幕 ${shots.length} 镜，生成其关联的 ${actSegments.length} 段连续视频，共 ${actSegments.reduce((count, segment) => count + segment.shotIds.length, 0)} 镜（跨幕片段将整体生成）。`;
    const insert = useMutation({
        mutationFn: ({ anchor, ticket }: { anchor: DramaShot; ticket: ReturnType<typeof operation.capture>; actId: string }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或账号已切换，请重新操作");
            return insertDramaShot(summary.project.id, anchor.id, "after");
        },
        onSuccess: ({ shot }, { ticket, actId }) => {
            if (!operation.isCurrent(ticket)) return;
            onChanged();
            if (activeAct.current === actId) onEditShot(shot);
        },
        onError: (error, { ticket }) => {
            if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "新增镜头失败");
        },
        onSettled: () => {
            insertLock.current = false;
        },
    });

    if (!first) return null;
    return (
        <div className="drama-storyboard-page">
            <nav className="drama-storyboard-acts thin-scrollbar" aria-label={`第 ${detail.episode.number} 集幕列表`}>
                <header>
                    <strong>共 {groups.length} 幕</strong>
                    <span>{detail.shots.length} 镜</span>
                </header>
                {groups.map((rows, index) => (
                    <button
                        key={rows[0].id}
                        type="button"
                        aria-pressed={index === actIndex}
                        onClick={() => {
                            setSelectedAct(rows[0].id);
                            setCollapsed(false);
                        }}
                    >
                        <span>
                            <strong>
                                第 {index + 1} 幕 {rows[0].scene || "未命名场景"}
                            </strong>
                            <small>{rows.length} 镜</small>
                        </span>
                    </button>
                ))}
            </nav>
            <section className="drama-storyboard-act" aria-label={`第 ${actIndex + 1} 幕分镜`}>
                <header className="drama-storyboard-act-toolbar">
                    <div>
                        <h4>
                            第 {actIndex + 1} 幕 {first.scene || "未命名场景"} <span>{shots.length} 镜</span>
                        </h4>
                    </div>
                    <div className="drama-storyboard-act-actions">
                        <Button size="small" type="text" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
                            {collapsed ? "展开" : "收起"}
                        </Button>
                        <WorkflowSceneSplits
                            summary={summary}
                            detail={detail}
                            initialShotId={first.id}
                            buttonLabel="重拆本幕"
                            onChanged={onChanged}
                            onOpenSegment={(index) => {
                                const shot = shots.find((item) => item.segmentIndex === index);
                                if (shot) onEditShot(shot);
                            }}
                        />
                        <Button size="small" onClick={() => setBoardOpen(true)}>
                            {boardLabel}
                        </Button>
                        <Button
                            size="small"
                            icon={<Plus className="size-3.5" />}
                            loading={insert.isPending}
                            onClick={() => {
                                const anchor = shots.at(-1);
                                if (!anchor || insertLock.current) return;
                                insertLock.current = true;
                                insert.mutate({ anchor, ticket: operation.capture(), actId: first.id });
                            }}
                        >
                            新增镜头
                        </Button>
                        <WorkflowBatch
                            compact
                            projectId={summary.project.id}
                            revision={summary.production.revision}
                            targetIds={actSegments.map((segment) => segment.id)}
                            targetLabels={Object.fromEntries(actSegments.map((segment) => [segment.id, `第 ${segment.index + 1} 段 · ${segment.title || "连续视频"}`]))}
                            actions={["segment_video"]}
                            triggerLabel="一键生成视频"
                            scopeDescription={batchScope}
                            disabled={!videoAllowed}
                            onChanged={onChanged}
                        />
                    </div>
                </header>
                {!collapsed ? (
                    <div className="drama-storyboard-shots-grid">
                        {shots.map((shot) => (
                            <StoryboardShotCard
                                key={shot.id}
                                shot={shot}
                                castById={castById}
                                status={status}
                                videoAllowed={videoAllowed}
                                defaultKind={defaultKind}
                                onOpen={(kind) => onOpenShot(shot, kind)}
                                onEdit={() => onEditShot(shot)}
                                onOpenCast={onOpenCast}
                            />
                        ))}
                    </div>
                ) : null}
                {!collapsed && status !== "all" ? <p className="drama-storyboard-filter-note">当前仅显示符合筛选条件的镜头；切换“全部状态”查看本幕所有镜头。</p> : null}
            </section>
            <WorkflowStoryboardDialog
                open={boardOpen}
                projectId={summary.project.id}
                shots={shots}
                title={mode === "grid_image" ? "宫格图" : "故事板"}
                onClose={() => {
                    setBoardOpen(false);
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
    status,
    videoAllowed,
    defaultKind,
    onOpen,
    onEdit,
    onOpenCast,
}: {
    shot: DramaShot;
    castById: Map<string, DramaCast>;
    status: string;
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
    if (status !== "all" && tone !== status) return null;
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
                            {subjects.map((cast) => (
                                <button type="button" key={cast.id} title={cast.name} onClick={() => onOpenCast(cast.id)}>
                                    {cast.imageResourceId ? <MediaThumb resourceId={cast.imageResourceId} alt="" /> : null}
                                    <span>{cast.name}</span>
                                </button>
                            ))}
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
