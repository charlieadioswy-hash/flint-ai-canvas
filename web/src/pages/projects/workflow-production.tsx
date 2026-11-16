import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Select } from "antd";
import { Clapperboard, Film, Package, RefreshCw } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { getDramaEpisode, getDramaWorkflowReadiness, renderDramaEpisode, retryFailedDrama, type DramaEpisodeDetail, type DramaEpisodeRow, type DramaJob, type DramaSegment, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { SimpleEpisodeFinalCard } from "./simple-studio-final-card";
import { SimpleStudioSegmentEditor } from "./simple-studio-segment-editor";
import { CastEditorDialog } from "./studio/cast-editor-dialog";
import { AssetPackageModal } from "./studio/asset-transfer";
import { DramaMediaActionDialog } from "./studio/drama-media-action-dialog";
import { QueueBar } from "./studio/queue-bar";
import { dramaKeys, useDramaCast, useDramaInvalidate } from "./studio/use-studio";
import { useDramaMediaAction } from "./studio/use-drama-media-action";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { WorkflowBatch } from "./workflow-batch";
import { WorkflowStoryboardPage } from "./workflow-storyboard-page";
import { WorkflowShotMediaDialog } from "./workflow-shot-media-dialog";
import "./drama.css";
import "./simple-studio.css";
import "./workflow-production.css";

export type WorkflowProductionProps = {
    summary: DramaSummary;
    step: "story" | "preview";
    onChanged: () => void | Promise<unknown>;
    embedded?: boolean;
    busy?: boolean;
    onPickChapters?: () => void;
    onDirtyChange?: (dirty: boolean, busy?: boolean) => void;
    onAllowMediaNavigation?: (next: { pathname: string; search: string }) => void;
};

function keepWorkflowQuery(search: URLSearchParams, step: "story" | "preview") {
    const next = new URLSearchParams(search);
    next.set("step", step);
    next.set("mode", "simple");
    next.delete("view");
    next.delete("tab");
    next.delete("cast");
    return next;
}

function workflowPath(projectId: string, episodeId: string | undefined, search: URLSearchParams, step: "story" | "preview") {
    const selectedStep = search.get("step");
    const next = keepWorkflowQuery(search, selectedStep === "preview" || selectedStep === "story" ? selectedStep : step);
    const path = `/projects/${encodeURIComponent(projectId)}${episodeId ? `/e/${encodeURIComponent(episodeId)}` : ""}`;
    return `${path}?${next}`;
}

function selectedEpisodeId(routeEpisodeId: string, queryEpisodeId: string | null) {
    return routeEpisodeId || queryEpisodeId || "";
}

function textFailure(episode: DramaEpisodeRow, detail?: DramaEpisodeDetail) {
    const current = detail?.episode || episode;
    const scriptError = detail?.scriptJob?.status === "failed" ? detail.scriptJob.error || current.error || episode.error : "";
    if (current.stage === "render") return "";
    if (current.stage === "script") return current.error || scriptError;
    return scriptError;
}

function renderFailure(episode: DramaEpisodeRow, detail?: DramaEpisodeDetail) {
    const current = detail?.episode || episode;
    return current.stage === "render" ? current.error : "";
}

function readyVideos(detail?: DramaEpisodeDetail) {
    return (detail?.segments || []).filter((segment) => segment.videoStatus === "ready" && segment.videoResourceId && (segment.videoSeconds || 0) > 0).length;
}

export function WorkflowProduction({ summary, step, onChanged, embedded = false, busy = false, onPickChapters, onDirtyChange, onAllowMediaNavigation }: WorkflowProductionProps) {
    const projectId = summary.project.id;
    const userId = useUserStore((state) => state.user?.id || "");
    const selectionOwner = `${userId}:${projectId}`;
    const { episodeId: routeEpisodeId = "" } = useParams();
    const navigate = useNavigate();
    const [search, setSearch] = useSearchParams();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const operation = useDramaOperationScope(projectId);
    const invalidate = useDramaInvalidate(projectId);
    const [castSelection, setCastSelection] = useState<{ owner: string; episodeId: string; id: string }>();
    const [exportProjectId, setExportProjectId] = useState<string>();
    const [mediaEditingState, setMediaEditingState] = useState({ dirty: false, busy: false });
    const mediaEditingChanged = useCallback(
        (dirty: boolean, busy = false) => {
            setMediaEditingState((current) => (current.dirty === dirty && current.busy === busy ? current : { dirty, busy }));
            onDirtyChange?.(dirty, busy);
        },
        [onDirtyChange],
    );
    const [selection, setSelection] = useState<{ owner: string; ids: Set<string> }>(() => ({ owner: selectionOwner, ids: new Set() }));
    const selected = selection.owner === selectionOwner ? selection.ids : new Set<string>();
    const selectionRef = useRef(selected);
    selectionRef.current = selected;
    useEffect(() => setSelection({ owner: selectionOwner, ids: new Set() }), [selectionOwner]);
    const jumpRequest = useRef(0);
    const scope = useRef({ projectId, search: search.toString() });
    scope.current = { projectId, search: search.toString() };
    useEffect(
        () => () => {
            jumpRequest.current += 1;
        },
        [projectId],
    );

    const jobsActive = Boolean((summary.jobCounts.queued || 0) + (summary.jobCounts.running || 0));
    const castQuery = useDramaCast(projectId, jobsActive, summary.production.revision);
    const refresh = useCallback(
        (episodeId?: string) => {
            void invalidate(episodeId);
            void queryClient.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) });
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "workflow-readiness"] });
            void queryClient.invalidateQueries({ queryKey: ["drama-shot-media", userId, projectId] });
            return onChanged();
        },
        [invalidate, onChanged, projectId, queryClient, userId],
    );
    const media = useDramaMediaAction({ projectId, onChanged: refresh });
    const episodes = summary.episodes;
    const queryEpisodeId = search.get("episode");
    const activeEpisodeId = selectedEpisodeId(routeEpisodeId, queryEpisodeId);
    const all = search.get("scope") === "all" || !activeEpisodeId;
    const castSelectionOwner = JSON.stringify([userId, projectId, activeEpisodeId, all]);
    useEffect(() => setCastSelection(undefined), [castSelectionOwner]);
    const visibleEpisodes = all ? episodes : episodes.filter((episode) => episode.id === activeEpisodeId);
    const queries = useQueries({
        queries: episodes.map((episode) => ({
            queryKey: dramaKeys.episode(projectId, episode.id),
            queryFn: ({ signal }: { signal: AbortSignal }) => getDramaEpisode(projectId, episode.id, signal),
            enabled: Boolean(projectId && (all || episode.id === activeEpisodeId)),
            refetchInterval: jobsActive ? 2_500 : false,
        })),
    });
    const previous = useRef(summary);
    useEffect(() => {
        const last = previous.current;
        previous.current = summary;
        if (last.project.id === projectId && (last.episodes !== summary.episodes || last.production.revision !== summary.production.revision)) {
            void queryClient.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) });
        }
    }, [projectId, queryClient, summary]);

    const retry = useMutation({
        mutationFn: ({ episodeId, target, ticket }: { episodeId: string; target: "text" | "render"; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或账号已切换，请重新操作");
            if (target === "render" && !textConfirmed) {
                const ready = episodeReadiness(episodeId);
                if (!ready?.canRender) throw new Error(mediaBlocker(episodeId) || "本集视频或合成任务尚未就绪");
                return renderDramaEpisode(ticket.projectId, episodeId, { expectedRevision: ready.revision });
            }
            return retryFailedDrama(ticket.projectId, episodeId, target);
        },
        onSuccess: (result, { episodeId, target, ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            void refresh(episodeId);
            if (result.jobs > 0) message.success(target === "render" ? "已提交本集成片合成重试" : "已提交本集重试");
            else message.info(target === "render" ? "本集没有可重试的失败合成任务，已刷新最新状态" : "本集没有可重试的失败文字任务，已刷新最新状态");
        },
        onError: (error, { ticket }) => {
            if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "重试失败");
        },
    });

    const indexParam = search.get("segment");
    const segmentIndex = indexParam !== null && /^\d+$/.test(indexParam) ? Number(indexParam) : undefined;
    const status = search.get("status") || "all";
    const guideStep = summary.guide?.step || summary.production.guideStep;
    const textConfirmed = guideStep === "completed" || !guideStep;
    const readiness = useQuery({
        queryKey: ["drama", projectId, "workflow-readiness", userId, summary.production.revision],
        queryFn: ({ signal }) => getDramaWorkflowReadiness(projectId, signal),
        enabled: Boolean(projectId && userId && (guideStep === "story" || step === "preview")),
        refetchInterval: jobsActive ? 2_500 : false,
    });
    const readinessCurrent = !readiness.isError && readiness.data?.revision === summary.production.revision && readiness.data.guideStep === guideStep;
    const episodeReadiness = (episodeId: string) => {
        if (!readinessCurrent) return undefined;
        const row = readiness.data?.episodes.find((item) => item.episodeId === episodeId);
        const query = queries.find((query) => query.data?.episode.id === episodeId);
        const detail = query?.data;
        return row && detail && !query.isError && row.revision === detail.episode.revision ? row : undefined;
    };
    const videoAllowed = (episodeId: string) => textConfirmed || Boolean(episodeReadiness(episodeId)?.canGenerateVideo);
    const mediaBlocker = (episodeId: string) => {
        if (textConfirmed) return "";
        if (guideStep !== "story") return "请先确认资产文字设定，再推进分集制作";
        if (readiness.isError) return "本集制作状态读取失败，请刷新后再生成";
        return episodeReadiness(episodeId)?.blockingReason || (videoAllowed(episodeId) ? "" : "正在核对本集文字与提示词，请稍后或刷新");
    };
    const textProgress = visibleEpisodes.reduce(
        (result, episode) => {
            const query = queries[episodes.findIndex((item) => item.id === episode.id)];
            const detail = query?.data;
            const current = detail?.episode || episode;
            if (query?.isError) result.unavailable += 1;
            else if (textFailure(episode, detail)) result.failedEpisodes.push(episode.number);
            else if (!detail || current.stage === "queued" || current.stage === "script" || !detail.segments.length) result.pendingEpisodes += 1;
            else result.readyEpisodes += 1;
            result.total += detail?.segments.length ?? episode.stats.segments;
            if (detail) {
                for (const segment of detail.segments) {
                    if (segment.promptStatus === "failed") result.failed += 1;
                    else if (segment.custom || segment.promptStatus === "ready") result.completed += 1;
                }
            } else result.completed += episode.stats.promptSucceeded;
            return result;
        },
        { total: 0, completed: 0, failed: 0, readyEpisodes: 0, pendingEpisodes: 0, unavailable: 0, failedEpisodes: [] as number[] },
    );
    const textProcessed = textProgress.total ? Math.min(100, Math.round(((textProgress.completed + textProgress.failed) / textProgress.total) * 100)) : 0;
    const openDetail = queries.find((query) => query.data?.episode.id === activeEpisodeId)?.data;
    const currentEpisode = episodes.find((episode) => episode.id === activeEpisodeId);
    const selectedLabels = Object.fromEntries(
        queries.flatMap((query) => {
            const detail = query.data;
            return detail ? detail.segments.map((segment) => [segment.id, `第 ${detail.episode.number} 集 · 第 ${segment.index + 1} 段${segment.title ? ` · ${segment.title}` : ""}`]) : [];
        }),
    );
    const selectSegments = (ids: string[], checked: boolean) => {
        const next = new Set(selectionRef.current);
        for (const id of ids) {
            if (checked) next.add(id);
            else next.delete(id);
        }
        if (next.size > 200) {
            message.info("每批最多选择 200 段，请缩小范围");
            return;
        }
        selectionRef.current = next;
        setSelection({ owner: selectionOwner, ids: next });
    };

    const replaceQuery = (episodeId: string | undefined, mutate: (next: URLSearchParams) => void, replace = true, authorizedMediaNavigation = false) => {
        const next = keepWorkflowQuery(search, step);
        mutate(next);
        if (routeEpisodeId || episodeId) {
            const destination = workflowPath(projectId, episodeId, next, step);
            if (authorizedMediaNavigation) {
                const queryStart = destination.indexOf("?");
                onAllowMediaNavigation?.({ pathname: destination.slice(0, queryStart), search: destination.slice(queryStart) });
            }
            navigate(destination, { replace });
        } else setSearch(next, { replace });
    };
    const openSegment = (episodeId: string, index: number | null, shotId?: string, authorizedMediaNavigation = false) => {
        replaceQuery(
            episodeId,
            (next) => {
                next.delete("editor");
                next.delete("media");
                if (all) next.set("scope", "all");
                else next.delete("scope");
                if (!routeEpisodeId) next.set("episode", episodeId);
                else next.delete("episode");
                if (index === null) {
                    next.delete("segment");
                    next.delete("shot");
                } else {
                    next.set("segment", String(index));
                    next.set("editor", "segment");
                    if (shotId) next.set("shot", shotId);
                    else next.delete("shot");
                }
            },
            index === null,
            authorizedMediaNavigation,
        );
    };
    const openShot = (episodeId: string, shotId?: string, kind?: "image" | "video" | "audio", authorizedMediaNavigation = false) => {
        replaceQuery(
            episodeId,
            (next) => {
                if (!routeEpisodeId) next.set("episode", episodeId);
                else next.delete("episode");
                const shot = queries.find((query) => query.data?.episode.id === episodeId)?.data?.shots.find((shot) => shot.id === (shotId || search.get("shot")));
                if (shot) next.set("segment", String(shot.segmentIndex));
                if (shotId) {
                    if (!shot) next.delete("segment");
                    next.set("editor", "media");
                    next.set("shot", shotId);
                    if (kind) next.set("media", kind);
                } else {
                    next.delete("editor");
                    next.delete("shot");
                    next.delete("media");
                }
            },
            !shotId,
            authorizedMediaNavigation,
        );
    };
    const closeSegmentEditor = () =>
        replaceQuery(activeEpisodeId, (next) => {
            next.delete("editor");
            next.delete("shot");
            next.delete("media");
        });
    const mediaShot = step === "story" && search.get("editor") === "media" ? openDetail?.shots.find((shot) => shot.id === search.get("shot")) : undefined;
    const mediaSegmentShots = mediaShot ? openDetail?.shots.filter((shot) => shot.segmentIndex === mediaShot.segmentIndex) : undefined;
    const requestVideo = (episode: DramaEpisodeRow, segment: DramaSegment) => {
        if (!videoAllowed(episode.id)) {
            message.info(mediaBlocker(episode.id));
            return;
        }
        if (segment.videoReprocessable) media.requestAction({ action: "segment_reprocess", targetId: segment.id, episodeId: episode.id, episodeNumber: episode.number, segmentTitle: segment.title, targetRevision: segment.revision });
        else media.requestVideo(episode, segment);
    };
    const requestPrompt = (episode: DramaEpisodeRow, segment: DramaSegment) => {
        media.requestAction({ action: "segment_prompt", targetId: segment.id, episodeId: episode.id, episodeNumber: episode.number, segmentTitle: segment.title, targetRevision: segment.revision });
    };
    const jumpToJob = async (job: DramaJob) => {
        if (mediaEditingState.dirty || mediaEditingState.busy) {
            message.info("请先保存或放弃当前镜头修改，再定位其他任务");
            return;
        }
        const episodeId = job.episodeId;
        if (!episodeId) return;
        const request = ++jumpRequest.current;
        const started = scope.current;
        const ticket = operation.capture();
        const current = () => operation.isCurrent(ticket) && request === jumpRequest.current && scope.current.projectId === started.projectId && scope.current.search === started.search;
        const next = keepWorkflowQuery(search, "story");
        next.delete("scope");
        next.delete("segment");
        next.delete("shot");
        next.delete("editor");
        next.delete("media");
        next.delete("status");
        if (!routeEpisodeId) next.set("episode", episodeId);
        else next.delete("episode");
        if (job.shotId && (job.kind === "segment_video" || job.kind === "segment_prompt")) {
            try {
                const detail = await queryClient.fetchQuery({ queryKey: dramaKeys.episode(projectId, episodeId), queryFn: ({ signal }) => getDramaEpisode(projectId, episodeId, signal), staleTime: 0 });
                if (!current()) return;
                const segment = detail.segments.find((item) => item.id === job.shotId);
                if (segment) next.set("segment", String(segment.index));
                else message.info("任务对应的剧情段已变更，已打开本集分镜");
            } catch (error) {
                if (current()) message.error(error instanceof Error ? error.message : "读取目标分镜失败，请重试");
                return;
            }
        }
        if (!current()) return;
        navigate(workflowPath(projectId, routeEpisodeId ? episodeId : undefined, next, "story"));
    };

    return (
        <div className={`drama-workflow-production ${embedded ? "is-embedded" : ""}`}>
            {mediaShot ? (
                <WorkflowShotMediaDialog
                    open
                    presentation="page"
                    projectId={projectId}
                    shot={mediaShot}
                    shots={mediaSegmentShots}
                    segmentLabel={`第 ${mediaShot.segmentIndex + 1} 段`}
                    initialKind={search.get("media") === "video" ? "video" : search.get("media") === "audio" ? "audio" : "image"}
                    onSelectShot={(shot, kind) => openShot(shot.episodeId, shot.id, kind, true)}
                    onEditText={() => openSegment(mediaShot.episodeId, mediaShot.segmentIndex, mediaShot.id, true)}
                    onClose={() => openShot(mediaShot.episodeId, undefined, undefined, true)}
                    onChanged={() => void refresh(mediaShot.episodeId)}
                    onDirtyChange={mediaEditingChanged}
                />
            ) : (
                <div className="drama-workflow-production-scroll thin-scrollbar">
                    <div className="drama-workflow-production-toolbar">
                        <h2>{step === "preview" ? "视频预览" : "分镜管理"}</h2>
                        <div className="drama-workflow-production-filters">
                            <Select
                                className="drama-workflow-production-episode-filter"
                                aria-label="选择集数"
                                disabled={busy}
                                value={all ? "all" : activeEpisodeId}
                                options={[{ value: "all", label: "全部集" }, ...episodes.map((episode) => ({ value: episode.id, label: `第 ${episode.number} 集 · ${episode.title || "未命名"}` }))]}
                                onChange={(id: string) =>
                                    replaceQuery(id === "all" ? undefined : id, (next) => {
                                        next.delete("segment");
                                        next.delete("shot");
                                        next.delete("editor");
                                        next.delete("media");
                                        if (id === "all") {
                                            next.set("scope", "all");
                                            next.delete("episode");
                                        } else {
                                            next.delete("scope");
                                            if (!routeEpisodeId) next.set("episode", id);
                                            else next.delete("episode");
                                        }
                                    })
                                }
                            />
                            {summary.production.reservedChapterCount > 0 ? (
                                <>
                                    <span className="drama-workflow-production-note" role="status" aria-atomic="true">
                                        原文 {summary.production.chapterCount + summary.production.reservedChapterCount} 章 · 制作 {episodes.length} 集 · 待制作 {summary.production.reservedChapterCount} 章
                                    </span>
                                    {onPickChapters ? (
                                        <Button size="small" disabled={busy || media.state.submitting || mediaEditingState.dirty || mediaEditingState.busy || retry.isPending} onClick={onPickChapters}>
                                            继续选章
                                        </Button>
                                    ) : null}
                                </>
                            ) : null}
                            {step === "story" ? (
                                <Select
                                    className="drama-workflow-production-status-filter"
                                    aria-label="筛选段状态"
                                    value={status}
                                    options={[
                                        { value: "all", label: "全部状态" },
                                        { value: "idle", label: "待处理" },
                                        { value: "busy", label: "处理中" },
                                        { value: "ready", label: "已就绪" },
                                        { value: "failed", label: "失败" },
                                        { value: "blocked", label: "等待条件" },
                                        { value: "stale", label: "待更新" },
                                    ]}
                                    onChange={(value: string) =>
                                        replaceQuery(activeEpisodeId || undefined, (next) => {
                                            if (value === "all") next.delete("status");
                                            else next.set("status", value);
                                        })
                                    }
                                />
                            ) : null}
                            <Button
                                type="text"
                                icon={<RefreshCw className="size-4" />}
                                aria-label="刷新制作进度"
                                onClick={() => {
                                    void refresh();
                                }}
                            />
                            {step === "preview" || step === "story" ? (
                                <Button icon={<Package className="size-4" />} onClick={() => setExportProjectId(projectId)}>
                                    下载全部素材
                                </Button>
                            ) : null}
                        </div>
                    </div>
                    {step === "story" ? (
                        <section className="drama-workflow-production-batch" aria-label="已选剧情段批量操作">
                            <strong>已选 {selected.size} 段</strong>
                            <WorkflowBatch
                                projectId={projectId}
                                revision={summary.production.revision}
                                targetIds={[...selected]}
                                targetLabels={selectedLabels}
                                actions={textConfirmed || readinessCurrent ? ["segment_prompt", "segment_assets", "segment_video"] : ["segment_prompt"]}
                                compact
                                scopeDescription={`范围：实际已选 ${selected.size} 个剧情段，包含跨筛选与切集保留的选择。`}
                                onChanged={() => refresh()}
                                onClearSelection={() => selectSegments([...selected], false)}
                            />
                        </section>
                    ) : null}
                    {!episodes.length ? (
                        <div className="drama-workflow-production-empty">
                            <Clapperboard className="size-7" />
                            <h3>{step === "preview" ? "还没有可预览的集" : "还没有分集分镜"}</h3>
                            <p>确认正文并完成文字制作后，这里会显示真实的集、段和视频。</p>
                        </div>
                    ) : null}
                    {step === "story"
                        ? visibleEpisodes.map((episode) => {
                              const query = queries[episodes.findIndex((item) => item.id === episode.id)];
                              const detail = query?.data;
                              const episodeCanGenerate = videoAllowed(episode.id);
                              const blocker = mediaBlocker(episode.id);
                              const scriptError = textFailure(episode, detail);
                              const current = detail?.episode || episode;
                              const failedWithoutSegments = Boolean(current.error) && current.stage !== "render" && (detail ? !detail.segments.length : episode.stats.segments === 0);
                              return (
                                  <section key={episode.id} className="drama-workflow-production-episode" aria-label={`第 ${episode.number} 集`}>
                                      <header>
                                          <span className="drama-workflow-production-number">{String(episode.number).padStart(2, "0")}</span>
                                          <div>
                                              <h3>{episode.title || `第 ${episode.number} 集`}</h3>
                                              <p>
                                                  {detail?.segments.length ?? episode.stats.segments} 段 · {detail?.shots.length ?? episode.shotCount} 镜
                                              </p>
                                              {blocker ? <p role="status">{blocker}</p> : guideStep === "story" ? <p role="status">本集文字已就绪，可独立生成视频；其他集可继续处理。</p> : null}
                                          </div>
                                          <div className="drama-workflow-production-actions">
                                              <Button size="small" onClick={() => replaceQuery(episode.id, (next) => next.set("step", "preview"))}>
                                                  视频预览
                                              </Button>
                                          </div>
                                      </header>
                                      {query?.isError ? <WorkspaceErrorState description="本集内容读取失败" onRetry={() => void query.refetch()} /> : null}
                                      {query?.isLoading ? <WorkspaceLoadingState label="正在读取本集分镜" /> : null}
                                      {scriptError || failedWithoutSegments ? (
                                          <div className="drama-workflow-production-error" role="alert">
                                              <strong>第 {episode.number} 集剧本与分镜未就绪</strong>
                                              <p>{scriptError || current.error}</p>
                                              <Button
                                                  size="small"
                                                  icon={<RefreshCw className="size-3.5" />}
                                                  loading={retry.isPending && retry.variables?.episodeId === episode.id && retry.variables.target === "text"}
                                                  disabled={retry.isPending}
                                                  onClick={() => retry.mutate({ episodeId: episode.id, target: "text", ticket: operation.capture() })}
                                              >
                                                  重试本集文字
                                              </Button>
                                          </div>
                                      ) : null}
                                      {detail && !detail.segments.length && !current.error && !scriptError ? (
                                          <p className="drama-workflow-production-empty">{detail.jobs.some((job) => job.status === "queued" || job.status === "running") ? "正在准备本集剧本与分镜，完成后自动显示" : "本集还没有分镜"}</p>
                                      ) : null}
                                      {detail?.segments.length ? (
                                          <WorkflowStoryboardPage
                                              summary={summary}
                                              detail={detail}
                                              castById={castQuery.byId}
                                              status={status}
                                              videoAllowed={episodeCanGenerate}
                                              onChanged={() => void refresh(episode.id)}
                                              onOpenShot={(shot, kind) => openShot(episode.id, shot.id, kind)}
                                              onEditShot={(shot) => openSegment(episode.id, shot.segmentIndex, shot.id)}
                                              onOpenCast={(id) => setCastSelection({ owner: castSelectionOwner, episodeId: episode.id, id })}
                                              segmentIndex={episode.id === activeEpisodeId ? segmentIndex : undefined}
                                              onSegmentChange={(index) =>
                                                  replaceQuery(episode.id, (next) => {
                                                      next.set("segment", String(index));
                                                      next.delete("editor");
                                                      next.delete("shot");
                                                      next.delete("media");
                                                      if (all) next.set("scope", "all");
                                                      else next.delete("scope");
                                                      if (!routeEpisodeId) next.set("episode", episode.id);
                                                      else next.delete("episode");
                                                  })
                                              }
                                              onOpenSegment={(index) => openSegment(episode.id, index)}
                                              onGenerateSegment={(segment) => requestVideo(episode, segment)}
                                              onWriteSegmentPrompt={(segment) => requestPrompt(episode, segment)}
                                              selectedSegmentIds={selected}
                                              onSelectSegments={selectSegments}
                                          />
                                      ) : null}
                                  </section>
                              );
                          })
                        : null}
                    {step === "preview"
                        ? visibleEpisodes.map((episode) => {
                              const query = queries[episodes.findIndex((item) => item.id === episode.id)];
                              const detail = query?.data;
                              const renderReadiness = episodeReadiness(episode.id);
                              const renderCount = renderReadiness?.renderVideoCount ?? detail?.segments.length ?? episode.stats.segments;
                              const renderReady = renderReadiness?.renderReadyVideos ?? (detail ? readyVideos(detail) : episode.stats.videoReady);
                              const renderUnit = renderReadiness?.renderSource === "shots" ? "镜" : "段";
                              const missing = Math.max(0, renderCount - renderReady);
                              const failed = renderFailure(episode, detail);
                              return (
                                  <section key={episode.id} className="drama-workflow-production-episode" aria-label={`第 ${episode.number} 集预览`}>
                                      <header>
                                          <span className="drama-workflow-production-number">{String(episode.number).padStart(2, "0")}</span>
                                          <div>
                                              <h3>{episode.title || `第 ${episode.number} 集`}</h3>
                                              <p>
                                                  {renderReady}/{renderCount} {renderUnit}视频就绪
                                                  {failed ? " · 成片合成失败" : ""}
                                              </p>
                                          </div>
                                          <div className="drama-workflow-production-actions">
                                              <Button size="small" icon={<Film className="size-3.5" />} onClick={() => replaceQuery(episode.id, (next) => next.set("step", "story"))}>
                                                  回到分镜
                                              </Button>
                                          </div>
                                      </header>
                                      {query?.isError ? <WorkspaceErrorState description="本集内容读取失败" onRetry={() => void query.refetch()} /> : null}
                                      {query?.isLoading ? <WorkspaceLoadingState label="正在读取本集视频" /> : null}
                                      {failed ? (
                                          <div className="drama-workflow-production-error" role="alert">
                                              <strong>第 {episode.number} 集成片合成失败</strong>
                                              <p>{failed}</p>
                                              <Button
                                                  size="small"
                                                  icon={<RefreshCw className="size-3.5" />}
                                                  loading={retry.isPending && retry.variables?.episodeId === episode.id && retry.variables.target === "render"}
                                                  disabled={retry.isPending || (!textConfirmed && !episodeReadiness(episode.id)?.canRender)}
                                                  onClick={() => retry.mutate({ episodeId: episode.id, target: "render", ticket: operation.capture() })}
                                              >
                                                  重试本集成片
                                              </Button>
                                          </div>
                                      ) : null}
                                      {missing > 0 ? (
                                          <div className="drama-workflow-production-notice" role="status">
                                              <p>
                                                  还有 {missing} {renderUnit}视频未就绪，生成完成后可合成本集。
                                              </p>
                                              {renderReadiness?.renderBlockingReason ? <p>{renderReadiness.renderBlockingReason}</p> : null}
                                          </div>
                                      ) : null}
                                      <div className="drama-workflow-production-preview-grid">
                                          <div className="drama-workflow-production-final">
                                              <SimpleEpisodeFinalCard
                                                  projectId={projectId}
                                                  title={summary.project.name}
                                                  episode={episode}
                                                  detail={detail}
                                                  readiness={renderReadiness}
                                                  unavailable={Boolean(query?.isError)}
                                                  blockingReason={
                                                      renderReadiness
                                                          ? renderReadiness.renderBlockingReason || (renderReadiness.canRender ? "" : renderReadiness.blockingReason || "本集视频或合成任务尚未就绪")
                                                          : mediaBlocker(episode.id) || (!textConfirmed ? "本集视频或合成任务尚未就绪" : "")
                                                  }
                                                  onChanged={() => refresh(episode.id)}
                                              />
                                          </div>
                                      </div>
                                  </section>
                              );
                          })
                        : null}
                    {step === "story" ? (
                        <details className="drama-workflow-production-advanced">
                            <summary>文字制作进度</summary>
                            <p className="drama-workflow-production-note">按连续剧情范围生成的视频与逐镜媒体分别保留。此处可继续管理已有视频和批次。</p>
                            {visibleEpisodes.length ? (
                                <section className="drama-workflow-production-progress" aria-label="文字制作进度">
                                    <div className="drama-workflow-production-progress-meta">
                                        <strong>段提示词进度</strong>
                                        <span>
                                            {textProgress.completed + textProgress.failed}/{textProgress.total} 段已处理
                                        </span>
                                        <span className="is-success">{textProgress.completed} 段已完成</span>
                                        <span className="is-failed">{textProgress.failed} 段失败</span>
                                        <span>{Math.max(0, textProgress.total - textProgress.completed - textProgress.failed)} 段待处理</span>
                                    </div>
                                    <div className="drama-workflow-production-progress-track" role="progressbar" aria-label="段提示词进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={textProcessed}>
                                        <span className="is-success" style={{ width: `${textProgress.total ? (textProgress.completed / textProgress.total) * 100 : 0}%` }} />
                                        <span className="is-failed" style={{ width: `${textProgress.total ? (textProgress.failed / textProgress.total) * 100 : 0}%` }} />
                                    </div>
                                    <div className="drama-workflow-production-progress-meta" role="status">
                                        <span>
                                            剧本与分镜：{textProgress.readyEpisodes}/{visibleEpisodes.length} 集就绪
                                        </span>
                                        {textProgress.failedEpisodes.length ? (
                                            <span className="is-failed">
                                                {textProgress.failedEpisodes.length} 集剧本失败（第 {textProgress.failedEpisodes.join("、")} 集）
                                            </span>
                                        ) : null}
                                        {textProgress.pendingEpisodes ? <span>{textProgress.pendingEpisodes} 集尚未就绪</span> : null}
                                        {textProgress.unavailable ? <span className="is-failed">{textProgress.unavailable} 集读取失败</span> : null}
                                    </div>
                                </section>
                            ) : null}
                        </details>
                    ) : null}
                    {episodes.length && !all && !currentEpisode ? (
                        <WorkspaceErrorState title="所选集不存在" description="该集可能已被删除，请选择其他集。" onRetry={() => replaceQuery(undefined, (next) => next.set("scope", "all"))} actionLabel="查看全部集" />
                    ) : null}
                </div>
            )}
            <QueueBar key={`${projectId}:${step}`} projectId={projectId} summary={summary} onJump={(job) => void jumpToJob(job)} />
            {step === "story" ? (
                <SimpleStudioSegmentEditor
                    summary={summary}
                    detail={openDetail}
                    episodeId={activeEpisodeId}
                    segmentIndex={search.get("editor") === "segment" ? segmentIndex : undefined}
                    shotId={search.get("shot") || undefined}
                    castById={castQuery.byId}
                    onClose={closeSegmentEditor}
                    onNavigate={(index, shotId) => openSegment(activeEpisodeId, index, shotId)}
                    onGenerate={(segment, model) => {
                        if (!currentEpisode) return;
                        if (!videoAllowed(currentEpisode.id)) {
                            message.info(mediaBlocker(currentEpisode.id));
                            return;
                        }
                        closeSegmentEditor();
                        media.requestVideo(currentEpisode, segment, model);
                    }}
                    onOpenCast={(id) => setCastSelection({ owner: castSelectionOwner, episodeId: activeEpisodeId, id })}
                />
            ) : null}
            {castSelection?.owner === castSelectionOwner ? (
                <CastEditorDialog
                    key={`${castSelectionOwner}:${castSelection.episodeId}:${castSelection.id}`}
                    summary={summary}
                    episodeId={castSelection.episodeId}
                    cast={castQuery.cast}
                    castId={castSelection.id}
                    onClose={() => setCastSelection(undefined)}
                    onChanged={() => void refresh(castSelection.episodeId)}
                />
            ) : null}
            {exportProjectId === projectId ? <AssetPackageModal key={projectId} open projectId={projectId} episodes={episodes} onClose={() => setExportProjectId(undefined)} /> : null}
            <DramaMediaActionDialog controller={media} />
        </div>
    );
}
