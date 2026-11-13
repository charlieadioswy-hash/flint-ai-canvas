import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button } from "antd";
import { Link, useBlocker, useParams, useSearchParams } from "react-router";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { AppModal } from "@/components/ui/product/app-modal";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { dramaChoiceKey, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import { ApiError } from "@/services/api/request";
import { confirmDramaGuide, listDramaJobs, retryFailedDrama, updateDramaWorkflowStyle, type DramaGuideStep, type DramaSettings, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { DramaProjectTopbar } from "./studio/project-topbar";
import { CastEditorDialog } from "./studio/cast-editor-dialog";
import { DramaMediaActionDialog } from "./studio/drama-media-action-dialog";
import { useDramaMediaAction } from "./studio/use-drama-media-action";
import { dramaKeys, useDramaCast, useDramaSummary } from "./studio/use-studio";
import { useDramaModelCatalog } from "./drama-model-picker";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { QueueBar } from "./studio/queue-bar";
import { dramaStudioPath, isAdvancedDramaStudio } from "./studio/studio-route";
import { WorkflowAssets } from "./workflow-assets";
import { WorkflowProduction } from "./workflow-production";
import { WorkflowConfiguration } from "./workflow-configuration";
import { WorkflowImpact } from "./workflow-impact";
import { WorkflowSourceReview } from "./workflow-source";
import { isWorkflowStepAllowed, resolveWorkflowStep, WORKFLOW_STEPS, type WorkflowStep } from "./workflow-state";
import "./drama.css";
import "./guide.css";
import "./workflow.css";

type SettingsDraft = { value: DramaSettings; baseline: DramaSettings; revision: number };

function sameSettings(left: DramaSettings, right: DramaSettings) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export default function DramaWorkflowPage() {
    const { projectId = "" } = useParams();
    const userId = useUserStore((state) => state.user?.id);
    return <DramaWorkflowSession key={`${userId}:${projectId}`} projectId={projectId} />;
}

function DramaWorkflowSession({ projectId }: { projectId: string }) {
    const { episodeId: routeEpisodeId } = useParams();
    const [searchParams, setSearchParams] = useSearchParams();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const summaryQuery = useDramaSummary(projectId);
    const summary = summaryQuery.data?.project.id === projectId ? summaryQuery.data : undefined;
    const catalog = useDramaModelCatalog();
    const jobsActive = Boolean(summary && (summary.jobCounts.queued || 0) + (summary.jobCounts.running || 0));
    const castQuery = useDramaCast(projectId, jobsActive, summary?.production.revision);
    const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
    const [editingCast, setEditingCast] = useState<string>();
    const [sourceState, setSourceState] = useState({ dirty: false, busy: false });
    const sourceChanged = useCallback((dirty: boolean, busy: boolean) => setSourceState({ dirty, busy }), []);
    const operation = useDramaOperationScope(projectId);
    const media = useDramaMediaAction({
        projectId,
        onChanged: () => queryClient.invalidateQueries({ queryKey: ["drama", projectId] }),
    });

    const stage = summary?.guide?.step || summary?.production.guideStep || "";
    const extractionJobs = useQuery({
        queryKey: dramaKeys.jobs(projectId),
        queryFn: ({ signal }) => listDramaJobs(projectId, 120, signal),
        enabled: Boolean(summary && stage === "assets" && summary.production.stage === "bible"),
        refetchInterval: jobsActive ? 2_500 : false,
    });
    const latestExtraction = extractionJobs.data?.jobs.filter((job) => job.kind === "bible").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const textFailed = Boolean(
        summary &&
        (summary.inbox?.some((item) => item.kind === "segment_failed" && item.media === "prompt") ||
            summary.episodes.some((episode) => episode.stage === "script" && episode.error) ||
            (stage === "assets" && summary.production.stage === "bible" && latestExtraction?.status === "failed")),
    );
    const requested = searchParams.get("step");
    const active = summary ? resolveWorkflowStep(summary, requested) : "review";

    const revision = summary?.production.revision || 0;
    const settings = settingsDraft?.value || summary?.production.settings;
    const settingsStale = Boolean(settingsDraft && settingsDraft.revision !== revision);
    const settingsDirty = Boolean(settingsDraft && !sameSettings(settingsDraft.value, settingsDraft.baseline));
    const confirmedNavigation = useRef<string | undefined>(undefined);
    const blocker = useBlocker(({ currentLocation, nextLocation }) => {
        if (currentLocation.pathname === nextLocation.pathname && confirmedNavigation.current === nextLocation.search) {
            confirmedNavigation.current = undefined;
            return false;
        }
        if (currentLocation.pathname !== nextLocation.pathname) return settingsDirty || sourceState.dirty || sourceState.busy;
        if (isAdvancedDramaStudio(new URLSearchParams(nextLocation.search))) return settingsDirty || sourceState.dirty || sourceState.busy;
        return (sourceState.dirty || sourceState.busy || (settingsDirty && stage !== "configuring")) && new URLSearchParams(currentLocation.search).get("step") !== new URLSearchParams(nextLocation.search).get("step");
    });
    useEffect(() => {
        if (!settingsDirty && !sourceState.dirty && !sourceState.busy) return;
        const preventLeave = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", preventLeave);
        return () => window.removeEventListener("beforeunload", preventLeave);
    }, [settingsDirty, sourceState]);

    const refresh = () => {
        void summaryQuery.refetch();
        void castQuery.refetch();
    };
    const openStep = (step: WorkflowStep) => {
        if (confirm.isPending || saveStyle.isPending) return;
        if (!summary || !isWorkflowStepAllowed(summary, step, { manualPreview: true })) return;
        if (sourceState.dirty || sourceState.busy || (settingsDirty && stage !== "configuring")) {
            message.info("请先保存或放弃当前修改，再切换步骤");
            return;
        }
        const next = new URLSearchParams(searchParams);
        next.set("step", step);
        setSearchParams(next, { replace: true });
    };

    const confirm = useMutation({
        mutationFn: async ({ expectedStep, ticket }: { expectedStep: DramaGuideStep; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (!summary || !settings) throw new Error("作品还没加载完成");
            if (sourceState.dirty || sourceState.busy) throw new Error("请先保存或放弃当前修改");
            if (settingsDirty && expectedStep !== "configuring") throw new Error("请先保存或放弃风格调整");
            if (settingsDraft && settingsDraft.revision !== summary.production.revision) throw new Error("配置已有更新，请重新载入后再确认");
            return confirmDramaGuide(projectId, { expectedStep, expectedRevision: summary.production.revision, ...(expectedStep === "configuring" ? { settings } : {}) });
        },
        onSuccess: async (next, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            setSettingsDraft(null);
            queryClient.setQueryData(dramaKeys.summary(projectId), next);
            const params = new URLSearchParams(searchParams);
            params.set("step", resolveWorkflowStep(next));
            // 只放行服务端确认成功后的这一次内部推进，编辑/确认期间的离开保护继续生效。
            confirmedNavigation.current = `?${params}`;
            setSearchParams(params, { replace: true });
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId] });
            message.success("已确认，进入下一步");
        },
        onError: (error, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            message.error(error instanceof ApiError && (error.reason === "conflict" || error.status === 409) ? "内容已有更新，未推进。请重新载入后再确认。" : error instanceof Error ? error.message : "确认失败");
            refresh();
        },
    });

    const saveStyle = useMutation({
        mutationFn: ({ ticket, draft }: { ticket: ReturnType<typeof operation.capture>; draft: SettingsDraft }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (draft.revision !== summary?.production.revision) throw new Error("配置已有更新，请重新载入后再保存");
            return updateDramaWorkflowStyle(ticket.projectId, { expectedRevision: draft.revision, styleName: draft.value.styleName, stylePrompt: draft.value.stylePrompt });
        },
        onSuccess: (next, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            setSettingsDraft(null);
            queryClient.setQueryData<DramaSummary>(dramaKeys.summary(ticket.projectId), (current) => (current && current.production.revision > next.production.revision ? current : next));
            void queryClient.invalidateQueries({ queryKey: ["drama", ticket.projectId] });
            message.success("已保存风格，已有产物保持当前版本");
        },
        onError: (error, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            message.error(error instanceof ApiError && (error.reason === "conflict" || error.status === 409) ? "内容已有更新，风格未保存。请重新载入后再确认。" : error instanceof Error ? error.message : "风格保存失败，已保留你的调整");
            refresh();
        },
    });

    const retryText = useMutation({
        mutationFn: (ticket: ReturnType<typeof operation.capture>) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            return retryFailedDrama(ticket.projectId, "", "text");
        },
        onSuccess: (result, ticket) => {
            if (!operation.isCurrent(ticket)) return;
            refresh();
            message.info(result.jobs ? `已重新排队 ${result.jobs} 项文字任务` : "没有可重试的失败文字任务");
        },
        onError: (error, ticket) => {
            if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "重试失败");
        },
    });

    const videoOption = catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(settings?.models.video));
    const configIssue = settings
        ? dramaVideoRatioIssue(videoOption, settings.aspectRatio) ||
          dramaVideoResolutionIssue(videoOption, settings.videoResolution) ||
          (videoOption && (settings.videoContinuity || "tail_frame") === "tail_frame" && !videoOption.tailFrameChain ? "不支持尾帧续接" : "")
        : "";
    const canConfirm = Boolean(summary?.guide?.canConfirm) && !settingsStale && !confirm.isPending && !saveStyle.isPending && !sourceState.dirty && !sourceState.busy && !(settingsDirty && stage !== "configuring");
    const blocking = summary?.guide?.blockingReason;

    return (
        <WorkspacePage className="drama-root drama-workflow-page" fluid>
            <DramaProjectTopbar
                name={summary?.project.name || "短剧制作"}
                stage="简易制作"
                controls={
                    <nav className="drama-workflow-steps" aria-label="短剧制作步骤">
                        {WORKFLOW_STEPS.map((step, index) => {
                            const allowed = summary ? isWorkflowStepAllowed(summary, step.key, { manualPreview: step.key === "preview" }) : false;
                            return (
                                <button key={step.key} type="button" aria-current={active === step.key ? "step" : undefined} disabled={!allowed || confirm.isPending || saveStyle.isPending} onClick={() => openStep(step.key)}>
                                    <span>{index + 1}</span>
                                    {step.title}
                                </button>
                            );
                        })}
                    </nav>
                }
            >
                <Link
                    to={dramaStudioPath(projectId, routeEpisodeId || searchParams.get("episode") || undefined, searchParams, "advanced")}
                    onClick={(event) => {
                        if (settingsDirty || sourceState.dirty || sourceState.busy) {
                            event.preventDefault();
                            message.info("请先保存或放弃当前修改，再打开详细制作台");
                        }
                    }}
                >
                    详细制作台
                </Link>
            </DramaProjectTopbar>
            {summaryQuery.isLoading ? <WorkspaceLoadingState label="正在读取短剧" /> : null}
            {summaryQuery.isError ? <WorkspaceErrorState title="短剧暂时无法读取" description={summaryQuery.error instanceof Error ? summaryQuery.error.message : "请重试"} onRetry={refresh} /> : null}
            {summary && settings ? (
                <div className="drama-workflow-body">
                    {active === "source" || active === "review" ? <WorkflowSourceReview summary={summary} busy={confirm.isPending} onChanged={refresh} onDirtyChange={sourceChanged} /> : null}
                    {active === "style" ? (
                        <>
                            {settingsStale ? (
                                <p className="drama-workflow-notice" role="alert">
                                    服务端配置已更新，当前调整基于旧版本，未覆盖你的修改。请重新载入后再继续。
                                    <Button size="small" type="link" onClick={() => setSettingsDraft(null)}>
                                        重新载入
                                    </Button>
                                </p>
                            ) : null}
                            <WorkflowConfiguration
                                summary={summary}
                                settings={settings}
                                disabled={confirm.isPending || saveStyle.isPending || settingsStale}
                                styleOnly={stage !== "configuring"}
                                onChange={(value) => {
                                    if (settingsDraft && settingsDraft.revision !== revision) return;
                                    setSettingsDraft({ value, baseline: settingsDraft?.baseline || summary.production.settings, revision: settingsDraft?.revision || revision });
                                }}
                            />
                            {stage !== "configuring" ? <WorkflowImpact projectId={projectId} revision={revision} /> : null}
                        </>
                    ) : null}
                    {active === "assets" ? (
                        <div className="drama-workflow-assets">
                            {stage === "assets" && blocking ? (
                                <p className="drama-workflow-notice" role="status">
                                    {blocking}
                                </p>
                            ) : null}
                            {textFailed ? (
                                <Button loading={retryText.isPending} onClick={() => retryText.mutate(operation.capture())}>
                                    重试失败的文字任务
                                </Button>
                            ) : null}
                            <WorkflowAssets
                                summary={summary}
                                cast={castQuery.cast}
                                busy={confirm.isPending || media.state.submitting || retryText.isPending}
                                loading={castQuery.isLoading}
                                error={castQuery.error}
                                onRetry={() => void castQuery.refetch()}
                                onChanged={refresh}
                                onGenerate={(cast) => media.requestCastImage(cast)}
                                onDirtyChange={sourceChanged}
                            />
                        </div>
                    ) : null}
                    {active === "story" || active === "preview" ? <WorkflowProduction summary={summary} step={active} onChanged={refresh} embedded /> : null}
                    <footer className="drama-workflow-footer">
                        {settingsStale ? (
                            <span role="alert">配置已有更新，请重新载入后再继续。未保存的调整不会被悄悄覆盖。</span>
                        ) : settingsDirty ? (
                            <span>{stage === "configuring" ? "配置调整会随确认一起提交。" : "风格调整尚未保存，保存只应用于后续制作。"}</span>
                        ) : blocking ? (
                            <span role="status">{blocking}</span>
                        ) : (
                            <span>浏览已完成步骤不会改变制作阶段。</span>
                        )}
                        {settingsStale ? (
                            <Button onClick={() => setSettingsDraft(null)}>重新载入配置</Button>
                        ) : active === "style" && stage !== "configuring" ? (
                            <>
                                {settingsDirty ? (
                                    <Button disabled={saveStyle.isPending} onClick={() => setSettingsDraft(null)}>
                                        放弃风格调整
                                    </Button>
                                ) : null}
                                <Button
                                    type="primary"
                                    disabled={!settingsDirty || !settings?.styleName.trim() || !settings?.stylePrompt.trim()}
                                    loading={saveStyle.isPending}
                                    onClick={() => settingsDraft && saveStyle.mutate({ ticket: operation.capture(), draft: settingsDraft })}
                                >
                                    保存风格
                                </Button>
                            </>
                        ) : stage === "configuring" && (active === "source" || active === "review") ? (
                            <Button type="primary" disabled={sourceState.dirty || sourceState.busy || !summary.production.chapterCount} onClick={() => openStep("style")}>
                                下一步：风格和基础配置
                            </Button>
                        ) : stage === "configuring" && active === "style" ? (
                            <Button type="primary" disabled={!canConfirm || Boolean(configIssue)} loading={confirm.isPending} onClick={() => confirm.mutate({ expectedStep: "configuring", ticket: operation.capture() })}>
                                确认配置并提取资产
                            </Button>
                        ) : stage === "assets" && active === "assets" ? (
                            <Button type="primary" disabled={!canConfirm} loading={confirm.isPending} onClick={() => confirm.mutate({ expectedStep: "assets", ticket: operation.capture() })}>
                                确认资产并继续
                            </Button>
                        ) : stage === "story" && active === "story" ? (
                            <Button type="primary" disabled={!canConfirm} loading={confirm.isPending} onClick={() => confirm.mutate({ expectedStep: "story", ticket: operation.capture() })}>
                                确认文字并进入视频制作
                            </Button>
                        ) : null}
                        {active === "style" && stage === "configuring" && configIssue ? <span role="alert">当前视频模型{configIssue}，请先调整后再确认。</span> : null}
                    </footer>
                    {active === "assets" ? (
                        <QueueBar
                            projectId={projectId}
                            summary={summary}
                            onJump={(job) => {
                                if (job.kind === "cast_image" && job.shotId) setEditingCast(job.shotId);
                            }}
                        />
                    ) : null}
                </div>
            ) : null}
            {summary && editingCast ? <CastEditorDialog summary={summary} cast={castQuery.cast} castId={editingCast} onClose={() => setEditingCast(undefined)} onChanged={refresh} /> : null}
            <DramaMediaActionDialog controller={media} />
            <AppModal
                open={blocker.state === "blocked"}
                title="当前修改尚未保存"
                onCancel={() => blocker.reset?.()}
                footer={[
                    <Button key="stay" onClick={() => blocker.reset?.()}>
                        继续编辑
                    </Button>,
                    <Button key="leave" danger onClick={() => blocker.proceed?.()}>
                        放弃修改并离开
                    </Button>,
                ]}
            >
                <p>离开后未保存的正文、范围或配置将丢失。正在提交的操作仍可能在服务端完成。</p>
            </AppModal>
        </WorkspacePage>
    );
}
