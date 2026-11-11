import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { App, Button, Select } from "antd";
import { ChevronDown, Clapperboard, Film, MessageSquare, Pencil, Play, RefreshCw, Settings2, Sparkles } from "lucide-react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { useGlobalAgentStore } from "@/stores/use-global-agent-store";
import { getDramaEpisode, retryFailedDrama, type DramaEpisodeRow, type DramaSegment, type DramaShot } from "@/services/api/drama";
import { activeDramaGuide, dramaProjectPath } from "./guide-state";
import { MediaThumb, mediaBusy, useResourceMediaUrl } from "./drama-shared";
import { dramaKeys, useDramaCast, useDramaInvalidate, useDramaSummary } from "./studio/use-studio";
import { SegmentStatus, secondsLabel, segmentState } from "./studio/segment-parts";
import { DramaProjectTopbar } from "./studio/project-topbar";
import { SimpleStudioSegmentEditor } from "./simple-studio-segment-editor";
import { dramaStudioPath } from "./studio/studio-route";
import { useDramaMediaAgent } from "./studio/use-drama-media-agent";
import "./drama.css";
import "./guide.css";
import "./simple-studio.css";

function VideoCover({ resourceId }: { resourceId: string }) {
    const url = useResourceMediaUrl(resourceId, "playback");
    return url ? <video src={`${url}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden /> : <Film className="size-6" />;
}

export function SimpleSegmentCard({ segment, shots, onOpen, onReference, onGenerate }: { segment: DramaSegment; shots: DramaShot[]; onOpen: () => void; onReference: () => void; onGenerate: () => void }) {
    const description =
        shots
            .map((shot) => (shot.dialogue ? `${shot.speaker || "旁白"}：${shot.dialogue}` : shot.action || shot.imagePrompt))
            .filter(Boolean)
            .join(" ") || "打开分镜，补充画面与台词";
    const generating = mediaBusy(segment.videoStatus);
    return (
        <article className="drama-simple-card" data-segment-id={segment.id}>
            <button className="drama-simple-cover" type="button" onClick={onOpen} aria-label={`编辑第 ${segment.index + 1} 段：${segment.title || "未命名场景"}`}>
                {segment.tailFrameResourceId ? (
                    <MediaThumb resourceId={segment.tailFrameResourceId} alt={segment.title} fallback={<Film className="size-6" />} />
                ) : segment.videoResourceId ? (
                    <VideoCover resourceId={segment.videoResourceId} />
                ) : (
                    <span className="drama-simple-cover-empty">
                        <Clapperboard className="size-6" />
                        <span>{generating ? "视频生成中" : "待生成画面"}</span>
                    </span>
                )}
                <span className="drama-simple-duration">{secondsLabel(segment.durationMs)}</span>
                <span className="drama-simple-edit">
                    <Pencil className="size-3" />
                    编辑
                </span>
            </button>
            <button className="drama-simple-card-copy" type="button" onClick={onOpen}>
                <strong>
                    第 {segment.index + 1} 段 · {segment.title || shots[0]?.scene || "未命名场景"}
                </strong>
                <p title={description}>{description}</p>
            </button>
            <div className="drama-simple-card-state">
                <SegmentStatus segment={segment} />
                <span>{shots.length} 镜</span>
            </div>
            <footer>
                <Button size="small" type="text" icon={<Sparkles className="size-3.5" />} aria-label={`引用第 ${segment.index + 1} 段与 AI 交流`} onClick={onReference}>
                    AI 交流
                </Button>
                <Button size="small" icon={<Play className="size-3" />} disabled={generating} onClick={onGenerate}>
                    {generating ? "生成中" : segment.videoReprocessable ? "重新处理" : segment.videoResourceId ? "重新生成" : "生成视频"}
                </Button>
            </footer>
        </article>
    );
}

export default function SimpleStudioPage() {
    const { projectId = "", episodeId: routeEpisodeId = "" } = useParams();
    const navigate = useNavigate();
    const [search, setSearch] = useSearchParams();
    const { message } = App.useApp();
    const summaryQuery = useDramaSummary(projectId);
    const summary = summaryQuery.data;
    const queryClient = useQueryClient();
    const invalidate = useDramaInvalidate(projectId);
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [mobilePane, setMobilePane] = useState<"chat" | "results">("results");
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const jobsActive = Boolean((summary?.jobCounts.queued || 0) + (summary?.jobCounts.running || 0));
    const castQuery = useDramaCast(projectId, jobsActive, summary?.production.revision);
    const onChanged = useCallback(
        (episodeId?: string) => {
            void invalidate(episodeId);
            void queryClient.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) });
        },
        [projectId, queryClient],
    );
    const mediaAgent = useDramaMediaAgent({ projectId, onChanged });
    const episodes = summary?.episodes || [];
    const all = search.get("scope") === "all" || !routeEpisodeId;
    const visibleEpisodes = all ? episodes : episodes.filter((episode) => episode.id === routeEpisodeId);
    const queries = useQueries({
        queries: episodes.map((episode) => ({
            queryKey: dramaKeys.episode(projectId, episode.id),
            queryFn: ({ signal }: { signal: AbortSignal }) => getDramaEpisode(projectId, episode.id, signal),
            enabled: Boolean(projectId && (all || episode.id === routeEpisodeId)),
            refetchInterval: jobsActive ? 2_500 : false,
        })),
    });
    const previousSummary = useRef<typeof summary>(undefined);
    useEffect(() => {
        const previous = previousSummary.current;
        previousSummary.current = summary;
        if (previous?.project.id === projectId && summary && (previous.episodes !== summary.episodes || previous.production.revision !== summary.production.revision)) void queryClient.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) });
    }, [projectId, queryClient, summary]);
    useEffect(() => {
        if (!host || summary?.project.id !== projectId || summary.production.hasDraftForm || activeDramaGuide(summary.production.guideStep)) return;
        const context = { projectId, guideConversationId: summary.production.guideConversationId, host, studioMode: true, onProposal: mediaAgent.onProposal, proposalChoices: mediaAgent.proposalChoices, prefillRequest: mediaAgent.prefillRequest };
        useGlobalAgentStore.getState().setDrama(context);
        return () => {
            if (useGlobalAgentStore.getState().drama === context) useGlobalAgentStore.getState().setDrama(null);
        };
    }, [host, projectId, summary?.project.id, summary?.production.hasDraftForm, summary?.production.guideStep, summary?.production.guideConversationId, mediaAgent.onProposal, mediaAgent.proposalChoices, mediaAgent.prefillRequest]);
    const retry = useMutation({
        mutationFn: ({ episodeId, target }: { episodeId: string; target: "text" | "render" }) => retryFailedDrama(projectId, episodeId, target),
        onSuccess: (result, { episodeId, target }) => {
            onChanged(episodeId);
            if (result.jobs > 0) message.success(target === "render" ? "已提交本集成片合成重试" : "已提交本集重试");
            else message.info(target === "render" ? "本集没有可重试的失败合成任务，已刷新最新状态" : "本集没有可重试的失败文字任务，已刷新最新状态");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "重试失败"),
    });
    const indexParam = search.get("segment");
    const segmentIndex = indexParam !== null && /^\d+$/.test(indexParam) ? Number(indexParam) : undefined;
    const openDetail = queries.find((query) => query.data?.episode.id === routeEpisodeId)?.data;
    const openSegment = (episodeId: string, index: number | null, shotId?: string) => {
        const next = new URLSearchParams(search);
        if (all) next.set("scope", "all");
        if (index === null) {
            next.delete("segment");
            next.delete("shot");
        } else {
            next.set("segment", String(index));
            if (shotId) next.set("shot", shotId);
            else next.delete("shot");
        }
        navigate(dramaStudioPath(projectId, episodeId, next, "simple"), { replace: index === null });
    };
    const reference = (episode: DramaEpisodeRow, segment: DramaSegment) => {
        mediaAgent.referenceSegment(episode, segment);
        setMobilePane("chat");
    };
    const requestVideo = (episode: DramaEpisodeRow, segment: DramaSegment) => {
        setMobilePane("chat");
        if (segment.videoReprocessable) {
            mediaAgent.referenceSegment(episode, segment);
            void mediaAgent.requestAction({ action: "segment_reprocess", targetId: segment.id, episodeId: episode.id, targetRevision: segment.revision });
        } else void mediaAgent.requestVideo(episode, segment);
    };
    const status = search.get("status") || "all";
    const setFilter = (key: string, value: string) => {
        const next = new URLSearchParams(search);
        value === "all" ? next.delete(key) : next.set(key, value);
        setSearch(next, { replace: true });
    };
    if (summary?.production.hasDraftForm) return <Navigate to={`/projects/new?draft=${encodeURIComponent(projectId)}`} replace />;
    if (summary && activeDramaGuide(summary.production.guideStep)) return <Navigate to={dramaProjectPath(projectId, summary.production.guideStep)} replace />;
    if (summaryQuery.isLoading)
        return (
            <WorkspacePage>
                <WorkspaceLoadingState label="正在加载简易制作台" />
            </WorkspacePage>
        );
    if (!summary)
        return (
            <WorkspacePage>
                <WorkspaceErrorState title="作品暂时无法读取" onRetry={() => void summaryQuery.refetch()} />
            </WorkspacePage>
        );
    const currentEpisode = episodes.find((episode) => episode.id === routeEpisodeId);
    const selectedEpisode = currentEpisode || episodes[0];
    return (
        <WorkspacePage fluid scroll={false}>
            <div className="drama-root drama-simple">
                <DramaProjectTopbar name={summary.project.name} stage="简易制作台">
                    <Button
                        icon={<Settings2 className="size-4" />}
                        onClick={() => {
                            const next = new URLSearchParams(search);
                            if (all) next.set("scope", "all");
                            navigate(dramaStudioPath(projectId, selectedEpisode?.id, next, "advanced"));
                        }}
                    >
                        详细设置
                    </Button>
                </DramaProjectTopbar>
                <div className="drama-guide-mobile-switch">
                    <button type="button" aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>
                        <MessageSquare className="size-4" />与 Agent 讨论
                    </button>
                    <button type="button" aria-pressed={mobilePane === "results"} onClick={() => setMobilePane("results")}>
                        <Film className="size-4" />
                        分集分镜
                    </button>
                </div>
                <div className={`drama-simple-layout is-${mobilePane}`}>
                    <aside className="drama-guide-chat" aria-label="短剧创作 Agent">
                        <div className="drama-guide-agent-host" ref={setHost} />
                    </aside>
                    <section className="drama-simple-results thin-scrollbar" aria-label="分集分镜">
                        <header className="drama-simple-toolbar">
                            <div>
                                <h2>分集分镜</h2>
                                <p>
                                    {episodes.length} 集 · {episodes.reduce((sum, episode) => sum + episode.stats.segments, 0)} 段{jobsActive ? ` · ${summary.jobCounts.queued || 0} 排队 / ${summary.jobCounts.running || 0} 进行中` : " · 修改随时保存"}
                                </p>
                            </div>
                            <div className="drama-simple-filters">
                                <Select
                                    aria-label="选择集数"
                                    value={all ? "all" : routeEpisodeId}
                                    options={[{ value: "all", label: "全部集" }, ...episodes.map((episode) => ({ value: episode.id, label: `第 ${episode.number} 集 · ${episode.title}` }))]}
                                    onChange={(id) => {
                                        const next = new URLSearchParams(search);
                                        next.delete("segment");
                                        next.delete("shot");
                                        next.delete("scope");
                                        navigate(dramaStudioPath(projectId, id === "all" ? undefined : id, next, "simple"));
                                    }}
                                />
                                <Select
                                    aria-label="筛选段状态"
                                    value={status}
                                    options={[
                                        { value: "all", label: "全部状态" },
                                        { value: "idle", label: "待生成" },
                                        { value: "busy", label: "生成中" },
                                        { value: "ready", label: "已完成" },
                                        { value: "failed", label: "失败" },
                                        { value: "blocked", label: "等待条件" },
                                        { value: "stale", label: "待更新" },
                                    ]}
                                    onChange={(value) => setFilter("status", value)}
                                />
                                <Button
                                    type="text"
                                    icon={<RefreshCw className="size-4" />}
                                    aria-label="刷新制作进度"
                                    loading={summaryQuery.isFetching}
                                    onClick={() => {
                                        void summaryQuery.refetch();
                                        void queryClient.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) });
                                    }}
                                />
                            </div>
                        </header>
                        {summaryQuery.isError ? (
                            <p className="drama-guide-notice" role="alert">
                                最新进度读取失败，当前为上次保存的数据。请刷新后操作。
                            </p>
                        ) : null}
                        {!episodes.length ? (
                            <div className="drama-guide-empty">
                                <Clapperboard className="size-7" />
                                <h3>还没有分集分镜</h3>
                                <p>可以与左侧 Agent 讨论创作内容，或进入详细设置继续准备剧本。</p>
                            </div>
                        ) : null}
                        {visibleEpisodes.map((episode) => {
                            const query = queries[episodes.findIndex((item) => item.id === episode.id)];
                            const detail = query?.data;
                            const segments = (detail?.segments || []).filter((segment) => status === "all" || segmentState(segment).tone === status);
                            const showAll = expanded.has(episode.id) || (episode.id === routeEpisodeId && segmentIndex !== undefined && segments.findIndex((segment) => segment.index === segmentIndex) >= 6);
                            const shown = showAll ? segments : segments.slice(0, 6);
                            const scriptError = detail?.scriptJob?.status === "failed" ? detail.scriptJob.error : "";
                            const renderError = episode.stage === "render" ? episode.error : "";
                            const textError = !renderError && (episode.stage === "script" ? episode.error || scriptError : scriptError);
                            const otherError = !renderError && !textError ? episode.error : "";
                            return (
                                <section key={episode.id} className="drama-simple-episode" aria-label={`第 ${episode.number} 集`}>
                                    <header>
                                        <span className="drama-simple-episode-number">{String(episode.number).padStart(2, "0")}</span>
                                        <div>
                                            <h3>{episode.title || `第 ${episode.number} 集`}</h3>
                                            <p>
                                                {episode.stats.segments} 段 · {episode.shotCount} 镜 · {episode.stats.videoReady} 段视频就绪
                                            </p>
                                        </div>
                                    </header>
                                    {query?.isError ? <WorkspaceErrorState description="本集内容读取失败" onRetry={() => void query.refetch()} /> : null}
                                    {query?.isLoading ? <WorkspaceLoadingState label="正在读取本集分镜" /> : null}
                                    {renderError || textError || otherError ? (
                                        <div className="drama-simple-error" role="alert">
                                            <strong>
                                                第 {episode.number} 集{renderError ? "成片合成失败" : textError ? "剧本与分镜未就绪" : "制作遇到问题"}
                                            </strong>
                                            <p>{renderError || textError || otherError}</p>
                                            <Button
                                                size="small"
                                                icon={<RefreshCw className="size-3.5" />}
                                                loading={retry.isPending && retry.variables?.episodeId === episode.id}
                                                disabled={summaryQuery.isError || retry.isPending}
                                                onClick={() => {
                                                    if (renderError || textError) retry.mutate({ episodeId: episode.id, target: renderError ? "render" : "text" });
                                                    else {
                                                        const next = new URLSearchParams(search);
                                                        next.delete("segment");
                                                        next.delete("shot");
                                                        next.set("view", "inbox");
                                                        navigate(dramaStudioPath(projectId, episode.id, next, "advanced"));
                                                    }
                                                }}
                                            >
                                                {renderError ? "重试本集成片" : textError ? "重试本集剧本" : "查看失败任务"}
                                            </Button>
                                        </div>
                                    ) : null}
                                    {detail && !detail.segments.length && !episode.error && !scriptError ? (
                                        <div className="drama-guide-empty">
                                            <p>{detail.jobs.some((job) => job.status === "queued" || job.status === "running") ? "正在准备本集剧本与分镜，完成后自动显示" : "本集还没有分镜，可通过 Agent 或详细设置继续制作"}</p>
                                        </div>
                                    ) : null}
                                    {detail?.segments.length && !segments.length ? <p className="drama-simple-empty">本集没有符合此状态的剧情段</p> : null}
                                    <div className="drama-simple-grid">
                                        {shown.map((segment) => (
                                            <SimpleSegmentCard
                                                key={segment.id}
                                                segment={segment}
                                                shots={detail?.shots.filter((shot) => shot.segmentIndex === segment.index) || []}
                                                onOpen={() => openSegment(episode.id, segment.index)}
                                                onReference={() => reference(episode, segment)}
                                                onGenerate={() => requestVideo(episode, segment)}
                                            />
                                        ))}
                                    </div>
                                    {segments.length > 6 ? (
                                        <Button
                                            className="drama-simple-expand"
                                            type="text"
                                            icon={<ChevronDown className="size-3.5" />}
                                            aria-expanded={showAll}
                                            onClick={() =>
                                                setExpanded((value) => {
                                                    const next = new Set(value);
                                                    if (next.has(episode.id)) next.delete(episode.id);
                                                    else next.add(episode.id);
                                                    return next;
                                                })
                                            }
                                        >
                                            {showAll ? "收起本集" : `展开其余 ${segments.length - 6} 段`}
                                        </Button>
                                    ) : null}
                                </section>
                            );
                        })}
                        {!all && !currentEpisode ? (
                            <WorkspaceErrorState title="所选集不存在" description="该集可能已被删除，请选择其他集。" onRetry={() => navigate(dramaStudioPath(projectId, undefined, new URLSearchParams(), "simple"))} actionLabel="查看全部集" />
                        ) : null}
                    </section>
                </div>
                <SimpleStudioSegmentEditor
                    summary={summary}
                    detail={openDetail}
                    episodeId={routeEpisodeId}
                    segmentIndex={segmentIndex}
                    shotId={search.get("shot") || undefined}
                    castById={castQuery.byId}
                    busy={summaryQuery.isError}
                    onClose={() => openSegment(routeEpisodeId, null)}
                    onNavigate={(index, shotId) => openSegment(routeEpisodeId, index, shotId)}
                    onGenerate={(segment, model) => {
                        if (currentEpisode) {
                            openSegment(routeEpisodeId, null);
                            setMobilePane("chat");
                            void mediaAgent.requestVideo(currentEpisode, segment, model);
                        }
                    }}
                    onOpenAdvancedCast={(id) => {
                        const next = new URLSearchParams(search);
                        next.set("view", "cast");
                        next.set("cast", id);
                        next.delete("segment");
                        next.delete("shot");
                        navigate(dramaStudioPath(projectId, routeEpisodeId, next, "advanced"));
                    }}
                />
            </div>
        </WorkspacePage>
    );
}
