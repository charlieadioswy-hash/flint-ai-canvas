import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Dropdown } from "antd";
import { ArrowRight, ChevronRight, FolderKanban, MoreHorizontal } from "lucide-react";
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { AppModal } from "@/components/ui/product/app-modal";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { dramaChoiceKey, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import { dramaDrawingConfiguration } from "@/lib/drama/drawing-configuration";
import { applyDramaGenerationConfiguration, dramaGenerationConfiguration } from "@/lib/drama/generation-configuration";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "@/lib/drama/style-limits";
import { ApiError } from "@/services/api/request";
import { confirmDramaGuide, getDramaEpisodeStyle, listDramaJobs, retryDramaProjectText, updateDramaEpisodeStyle, updateDramaSettings, updateDramaWorkflowStyle, type DramaGuideStep, type DramaSettings, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { DramaProjectTopbar } from "./studio/project-topbar";
import { CastEditorDialog } from "./studio/cast-editor-dialog";
import { ChapterPickerModal } from "./studio/chapter-picker";
import { DramaMediaActionDialog } from "./studio/drama-media-action-dialog";
import { useDramaMediaAction } from "./studio/use-drama-media-action";
import { DramaMediaActionProvider } from "./studio/drama-media-action-context";
import { dramaKeys, useDramaCast, useDramaSummary } from "./studio/use-studio";
import { useDramaModelCatalog } from "./drama-model-picker";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { QueueBar } from "./studio/queue-bar";
import { dramaStudioPath, isAdvancedDramaStudio } from "./studio/studio-route";
import { WorkflowAssets } from "./workflow-assets";
import { WorkflowProduction } from "./workflow-production";
import { WorkflowConfiguration, type WorkflowConfigurationHandle } from "./workflow-configuration";
import { WorkflowImpact } from "./workflow-impact";
import { WorkflowSourceReview } from "./workflow-source";
import { WorkflowModeDialog } from "./workflow-mode-dialog";
import { WorkflowEpisodes } from "./workflow-episodes";
import { EPISODE_WORKFLOW_STEPS, isWorkflowStepAllowed, resolveWorkflowStep, WORKFLOW_STEPS, type WorkflowStep } from "./workflow-state";
import "./drama.css";
import "./guide.css";
import "./workflow.css";

type SettingsDraft = { value: DramaSettings; baseline: DramaSettings; revision: number; episodeRevision?: number };

function sameSettings(left: DramaSettings, right: DramaSettings) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export default function DramaWorkflowPage() {
    const { projectId = "", episodeId } = useParams();
    const [searchParams] = useSearchParams();
    const userId = useUserStore((state) => state.user?.id);
    const episodeScope = episodeId || (!searchParams.has("manage") && searchParams.get("episode")) || "project";
    return <DramaWorkflowSession key={`${userId}:${projectId}:${episodeScope}`} projectId={projectId} />;
}

function DramaWorkflowSession({ projectId }: { projectId: string }) {
    const { episodeId: routeEpisodeId } = useParams();
    const userId = useUserStore((state) => state.user?.id);
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const summaryQuery = useDramaSummary(projectId);
    const summary = summaryQuery.data?.project.id === projectId ? summaryQuery.data : undefined;
    const catalog = useDramaModelCatalog();
    const jobsActive = Boolean(summary && (summary.jobCounts.queued || 0) + (summary.jobCounts.running || 0));
    const castQuery = useDramaCast(projectId, jobsActive, summary?.production.revision);
    const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
    const [configurationSyncError, setConfigurationSyncError] = useState("");
    const failedConfiguration = useRef("");
    const [editingCast, setEditingCast] = useState<string>();
    const [sourceEditorState, setSourceEditorState] = useState({ dirty: false, busy: false, automatic: false });
    const [chapterPickerState, setChapterPickerState] = useState({ dirty: false, busy: false });
    const sourceState = useMemo(() => ({ dirty: sourceEditorState.dirty || chapterPickerState.dirty, busy: sourceEditorState.busy || chapterPickerState.busy }), [sourceEditorState, chapterPickerState]);
    const [chapterPickerOpen, setChapterPickerOpen] = useState(false);
    const [modeOpen, setModeOpen] = useState(false);
    const [modeConfigurationPending, setModeConfigurationPending] = useState(false);
    const modeGenerationFlush = useRef<(() => Promise<boolean>) | null>(null);
    const modeNavigationPending = useRef(false);
    const modeGenerationChanged = useCallback((pending: boolean) => setModeConfigurationPending(pending), []);
    const registerModeGenerationFlush = useCallback((flush: (() => Promise<boolean>) | null) => {
        modeGenerationFlush.current = flush;
    }, []);
    const configuration = useRef<WorkflowConfigurationHandle>(null);
    const sourceChanged = useCallback(
        (dirty: boolean, busy = false, automatic = false) => setSourceEditorState((current) => (current.dirty === dirty && current.busy === busy && current.automatic === automatic ? current : { dirty, busy, automatic })),
        [],
    );
    const chapterPickerChanged = useCallback((dirty: boolean, busy = false) => setChapterPickerState((current) => (current.dirty === dirty && current.busy === busy ? current : { dirty, busy })), []);
    const operation = useDramaOperationScope(projectId);
    const media = useDramaMediaAction({
        projectId,
        revision: summary?.production.revision,
        refreshKey: JSON.stringify(summary?.jobCounts),
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
    const management = searchParams.get("manage");
    const managing = management !== null || Boolean(summary && summary.episodes.length > 0 && stage !== "configuring" && !summary.production.hasDraftForm && !routeEpisodeId && !searchParams.has("step") && !searchParams.has("episode"));
    const managementTab = ["script", "style", "assets", "episodes"].includes(management || "") ? management : "episodes";
    const episodesView = managing && managementTab === "episodes";
    const resolvedStep = summary ? resolveWorkflowStep(summary, requested) : "review";
    const active = managing ? (managementTab === "script" ? "review" : managementTab === "style" ? "style" : managementTab === "assets" ? "assets" : "story") : routeEpisodeId && resolvedStep === "source" ? "review" : resolvedStep;
    const steps = routeEpisodeId ? EPISODE_WORKFLOW_STEPS : WORKFLOW_STEPS;

    const revision = summary?.production.revision || 0;
    const episodeStyleId = managing ? undefined : routeEpisodeId || searchParams.get("episode") || undefined;
    const initialConfiguration = stage === "configuring" && !episodeStyleId;
    const episodeStyleKey = ["drama-episode-style", userId, projectId, episodeStyleId, revision];
    const episodeStyleQuery = useQuery({ queryKey: episodeStyleKey, queryFn: ({ signal }) => getDramaEpisodeStyle(projectId, episodeStyleId!, signal), enabled: Boolean(summary && episodeStyleId), placeholderData: keepPreviousData });
    const episodeStyle = episodeStyleQuery.data && episodeStyleQuery.data.episodeId === episodeStyleId && episodeStyleQuery.data.projectId === projectId ? episodeStyleQuery.data : undefined;
    const episodeConfigurationBusy = Boolean(episodeStyleId && (!episodeStyle || episodeStyleQuery.isPlaceholderData || episodeStyleQuery.isError));
    const episodeSummary = useMemo(() => (summary && episodeStyle ? { ...summary, production: { ...summary.production, settings: episodeStyle.settings } } : summary), [summary, episodeStyle]);
    const savedSettings = episodeStyleId ? episodeStyle?.settings : summary?.production.settings;
    const settings = settingsDraft?.value || savedSettings || summary?.production.settings;
    const settingsStale = Boolean(settingsDraft && settingsDraft.revision !== revision);
    const settingsDirty = Boolean(settingsDraft && !sameSettings(settingsDraft.value, settingsDraft.baseline));
    const generationKey = settings ? JSON.stringify(dramaGenerationConfiguration(settings)) : "";
    const generationDirty = Boolean(settingsDraft && generationKey !== JSON.stringify(dramaGenerationConfiguration(settingsDraft.baseline)));
    const otherSettingsDirty = Boolean(settingsDraft && !sameSettings(settingsDraft.value, applyDramaGenerationConfiguration(settingsDraft.baseline, settingsDraft.value)));
    const confirmedNavigation = useRef<string | undefined>(undefined);
    const confirmedMediaNavigation = useRef<{ pathname: string; search: string } | undefined>(undefined);
    const blocker = useBlocker(({ currentLocation, nextLocation }) => {
        const mediaNavigation = confirmedMediaNavigation.current;
        if (mediaNavigation) {
            confirmedMediaNavigation.current = undefined;
            if (mediaNavigation.pathname === nextLocation.pathname && mediaNavigation.search === nextLocation.search) return false;
        }
        if (currentLocation.pathname === nextLocation.pathname && confirmedNavigation.current === nextLocation.search) {
            confirmedNavigation.current = undefined;
            return false;
        }
        if (saveStyle.isPending || modeConfigurationPending) return true;
        if (currentLocation.pathname !== nextLocation.pathname) return settingsDirty || sourceState.dirty || sourceState.busy;
        if (isAdvancedDramaStudio(new URLSearchParams(nextLocation.search))) return settingsDirty || sourceState.dirty || sourceState.busy;
        const current = new URLSearchParams(currentLocation.search);
        const next = new URLSearchParams(nextLocation.search);
        const pageChanged = ["step", "manage", "episode"].some((key) => current.get(key) !== next.get(key));
        const mediaChanged = (current.get("editor") === "media" || next.get("editor") === "media") && ["editor", "shot", "segment", "episode", "media", "scope"].some((key) => current.get(key) !== next.get(key));
        return (sourceState.dirty || sourceState.busy || (settingsDirty && !initialConfiguration)) && (pageChanged || mediaChanged);
    });
    const latestBlocker = useRef(blocker);
    latestBlocker.current = blocker;
    useEffect(() => {
        if (blocker.state !== "blocked" || !modeConfigurationPending || modeNavigationPending.current || !modeGenerationFlush.current) return;
        modeNavigationPending.current = true;
        const ticket = operation.capture();
        void modeGenerationFlush
            .current()
            .then((applied) => {
                if (!operation.isCurrent(ticket) || latestBlocker.current.state !== "blocked") return;
                if (!applied) latestBlocker.current.reset?.();
                else if (!settingsDirty && !sourceState.dirty && !sourceState.busy && !saveStyle.isPending) latestBlocker.current.proceed?.();
            })
            .finally(() => {
                modeNavigationPending.current = false;
            });
    }, [blocker.state, modeConfigurationPending]);
    useEffect(() => {
        if (blocker.state === "blocked" && sourceEditorState.automatic && !settingsDirty && !sourceState.dirty && !sourceState.busy && !saveStyle.isPending && !modeConfigurationPending) blocker.proceed?.();
    }, [blocker.state, sourceEditorState.automatic, settingsDirty, sourceState.dirty, sourceState.busy, modeConfigurationPending]);
    useEffect(() => {
        if (!settingsDirty && !sourceState.dirty && !sourceState.busy && !modeConfigurationPending) return;
        const preventLeave = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", preventLeave);
        return () => window.removeEventListener("beforeunload", preventLeave);
    }, [settingsDirty, sourceState, modeConfigurationPending]);

    const refresh = () => {
        void summaryQuery.refetch();
        void castQuery.refetch();
    };
    const openStep = (step: WorkflowStep) => {
        if (confirm.isPending || saveStyle.isPending) return;
        if (managing) {
            openManagement(step === "review" ? "script" : step === "style" ? "style" : step === "assets" ? "assets" : "episodes");
            return;
        }
        if (!summary || !isWorkflowStepAllowed(summary, step, { manualPreview: true })) return;
        if (sourceState.dirty || (sourceState.busy && !sourceEditorState.automatic) || (otherSettingsDirty && !initialConfiguration)) {
            message.info("请先保存或放弃当前修改，再切换步骤");
            return;
        }
        const next = new URLSearchParams(searchParams);
        next.delete("manage");
        next.set("step", step);
        setSearchParams(next, { replace: true });
    };
    const openManagement = (tab: string) => {
        if (confirm.isPending || saveStyle.isPending) return;
        const next = new URLSearchParams(searchParams);
        for (const key of ["step", "episode", "segment", "shot", "media", "editor", "scope", "status"]) next.delete(key);
        next.set("manage", tab);
        if (routeEpisodeId) navigate(`/projects/${encodeURIComponent(projectId)}/guide?${next}`, { replace: true });
        else setSearchParams(next, { replace: true });
    };

    const confirm = useMutation({
        mutationFn: async ({ expectedStep, ticket, modeSettings }: { expectedStep: DramaGuideStep; ticket: ReturnType<typeof operation.capture>; modeSettings?: DramaSettings }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (!summary || !settings) throw new Error("作品还没加载完成");
            if (sourceState.dirty || sourceState.busy) throw new Error("请先保存或放弃当前修改");
            if (settingsDirty && expectedStep !== "configuring") throw new Error("请先保存或放弃风格调整");
            if (settingsDraft && settingsDraft.revision !== summary.production.revision) throw new Error("配置已有更新，请重新载入后再确认");
            return confirmDramaGuide(projectId, { expectedStep, expectedRevision: summary.production.revision, ...(expectedStep === "configuring" ? { settings } : modeSettings ? { settings: modeSettings } : {}) });
        },
        onSuccess: async (next, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            setSettingsDraft(null);
            setModeOpen(false);
            queryClient.setQueryData(dramaKeys.summary(projectId), next);
            const params = new URLSearchParams(searchParams);
            params.delete("manage");
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

    const continueToAssets = () => {
        const params = new URLSearchParams(searchParams);
        if (managing) {
            params.delete("step");
            params.set("manage", "assets");
        } else {
            params.delete("manage");
            params.set("step", "assets");
        }
        confirmedNavigation.current = `?${params}`;
        setSearchParams(params, { replace: true });
    };
    const saveStyle = useMutation({
        mutationFn: async ({ ticket, draft }: { ticket: ReturnType<typeof operation.capture>; draft: SettingsDraft; automatic?: boolean }) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (draft.revision !== summary?.production.revision) throw new Error("配置已有更新，请重新载入后再保存");
            const drawing = dramaDrawingConfiguration(draft.value);
            const drawingChange = JSON.stringify(drawing) !== JSON.stringify(dramaDrawingConfiguration(draft.baseline)) ? { drawing } : {};
            if (episodeStyleId) {
                if (draft.episodeRevision === undefined) throw new Error("本集配置尚未读取，请重新载入");
                const style = await updateDramaEpisodeStyle(ticket.projectId, episodeStyleId, {
                    expectedRevision: draft.revision,
                    expectedEpisodeRevision: draft.episodeRevision,
                    settings: draft.value,
                });
                return { scope: "episode" as const, style };
            }
            if (initialConfiguration) return { scope: "project" as const, summary: await updateDramaSettings(ticket.projectId, { expectedRevision: draft.revision, settings: draft.value }) };
            return { scope: "project" as const, summary: await updateDramaWorkflowStyle(ticket.projectId, { expectedRevision: draft.revision, styleName: draft.value.styleName, stylePrompt: draft.value.stylePrompt, ...drawingChange }) };
        },
        onSuccess: (result, { ticket, draft, automatic }) => {
            if (!operation.isCurrent(ticket)) return;
            const saved = result.scope === "episode" ? result.style.settings : result.summary.production.settings;
            const savedRevision = result.scope === "episode" ? result.style.revision : result.summary.production.revision;
            const cachedRevision = queryClient.getQueryData<DramaSummary>(dramaKeys.summary(ticket.projectId))?.production.revision || 0;
            if (cachedRevision > savedRevision) {
                failedConfiguration.current = JSON.stringify(dramaGenerationConfiguration(draft.value));
                setConfigurationSyncError("配置已有更新，请重新载入后再调整。当前修改已保留。");
                return;
            }
            setConfigurationSyncError("");
            failedConfiguration.current = "";
            setSettingsDraft((current) => {
                if (!automatic || !current) return null;
                const value = applyDramaGenerationConfiguration(current.value, saved);
                return sameSettings(value, saved) ? null : { value, baseline: saved, revision: savedRevision, ...(result.scope === "episode" ? { episodeRevision: result.style.episodeRevision } : {}) };
            });
            if (result.scope === "episode") {
                const { style } = result;
                queryClient.setQueryData(["drama-episode-style", userId, projectId, episodeStyleId, style.revision], style);
                queryClient.setQueryData<DramaSummary>(dramaKeys.summary(ticket.projectId), (current) =>
                    current && current.production.revision <= style.revision
                        ? {
                              ...current,
                              production: { ...current.production, revision: style.revision },
                              episodes: current.episodes.map((episode) => (episode.id === style.episodeId ? { ...episode, revision: style.episodeRevision } : episode)),
                          }
                        : current,
                );
            } else {
                const next = result.summary;
                queryClient.setQueryData<DramaSummary>(dramaKeys.summary(ticket.projectId), (current) => (current && current.production.revision > next.production.revision ? current : next));
            }
            void queryClient.invalidateQueries({ queryKey: ["drama-episode-style", userId, projectId] });
            void queryClient.invalidateQueries({ queryKey: ["drama", ticket.projectId] });
            if (automatic) {
                if (blocker.state === "blocked" && !otherSettingsDirty && !sourceState.dirty && !sourceState.busy && !modeConfigurationPending) blocker.proceed?.();
            } else {
                blocker.reset?.();
                message.success(episodeStyleId ? "本集配置已保存，已有产物保持当前版本" : "作品配置已保存，各集保持自己的配置");
                continueToAssets();
            }
        },
        onError: (error, { ticket, draft, automatic }) => {
            if (!operation.isCurrent(ticket)) return;
            const text = error instanceof ApiError && (error.reason === "conflict" || error.status === 409) ? "内容已有更新，配置未同步。请重新载入后再调整。" : error instanceof Error ? error.message : "配置同步失败，已保留你的调整";
            if (automatic) {
                failedConfiguration.current = JSON.stringify(dramaGenerationConfiguration(draft.value));
                setConfigurationSyncError(text);
                blocker.reset?.();
            } else message.error(text);
            refresh();
        },
    });

    const retryText = useMutation({
        mutationFn: (ticket: ReturnType<typeof operation.capture>) => {
            if (!operation.isCurrent(ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            return retryDramaProjectText(ticket.projectId);
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
    const episodeStyleIssue =
        episodeStyleId && settings
            ? Array.from(settings.styleName).length > 60
                ? "本集风格名称不能超过 60 字，请缩短名称后再保存。"
                : Array.from(settings.stylePrompt).length > DRAMA_STYLE_PROMPT_MAX_LENGTH
                  ? `本集风格说明不能超过 ${DRAMA_STYLE_PROMPT_MAX_LENGTH} 字，请缩短说明后再保存。`
                  : ""
            : "";
    useEffect(() => {
        if (!generationDirty || !settingsDraft || settingsStale || episodeConfigurationBusy || confirm.isPending || saveStyle.isPending || configIssue || failedConfiguration.current === generationKey) return;
        const timeout = window.setTimeout(
            () => {
                setConfigurationSyncError("");
                saveStyle.mutate({ ticket: operation.capture(), draft: { ...settingsDraft, value: applyDramaGenerationConfiguration(settingsDraft.baseline, settingsDraft.value) }, automatic: true });
            },
            blocker.state === "blocked" && !otherSettingsDirty ? 0 : 350,
        );
        return () => window.clearTimeout(timeout);
    }, [generationKey, generationDirty, settingsDraft, settingsStale, episodeConfigurationBusy, confirm.isPending, saveStyle.isPending, configIssue, blocker.state, otherSettingsDirty, configurationSyncError]);
    const canConfirm =
        Boolean(summary?.guide?.canConfirm) && !episodeConfigurationBusy && !settingsStale && !generationDirty && !confirm.isPending && !saveStyle.isPending && !sourceState.dirty && !sourceState.busy && !(settingsDirty && !initialConfiguration);
    const blocking = (stage === "assets" && active === "assets") || (stage === "story" && active === "story") ? summary?.guide?.blockingReason : undefined;
    const chapterPickerBusy = confirm.isPending || saveStyle.isPending || retryText.isPending || media.state.submitting || sourceEditorState.busy;
    const openChapterPicker = () => {
        if (!summary?.production.reservedChapterCount || chapterPickerBusy) return;
        if (settingsDirty || sourceEditorState.dirty) {
            message.info(generationDirty && !otherSettingsDirty && !sourceEditorState.dirty ? "生成配置正在同步，请稍候再继续选章" : "请先保存或放弃当前修改，再继续选章");
            return;
        }
        setChapterPickerOpen(true);
    };
    const footerStatus = configurationSyncError ? (
        <span role="alert">
            {configurationSyncError}
            {!settingsStale && generationDirty ? (
                <Button
                    type="link"
                    size="small"
                    disabled={saveStyle.isPending}
                    onClick={() => {
                        failedConfiguration.current = "";
                        setConfigurationSyncError("");
                    }}
                >
                    重新同步配置
                </Button>
            ) : null}
        </span>
    ) : settingsStale ? (
        <span role="alert">配置已有更新，请重新载入后再继续。未保存的调整不会被悄悄覆盖。</span>
    ) : generationDirty && configIssue ? (
        <span role="alert">当前视频模型{configIssue}，生成配置尚未生效。</span>
    ) : generationDirty && episodeConfigurationBusy ? (
        <span role="alert">本集配置尚未读取完成，暂时无法同步你的调整。</span>
    ) : generationDirty && !otherSettingsDirty ? (
        <span role="status">正在同步生成配置…</span>
    ) : settingsDirty ? (
        <span>{initialConfiguration ? "配置调整会随确认一起提交。" : "风格调整尚未保存，保存只应用于后续制作。"}</span>
    ) : blocking && active !== "assets" ? (
        <span role="status">{blocking}</span>
    ) : sourceState.dirty ? (
        <span>当前内容尚未保存</span>
    ) : null;
    const hasFooterAction = active === "style" || active === "source" || (active === "review" && (managing || Boolean(routeEpisodeId) || stage !== "configuring")) || (stage === "story" && active === "story");

    return (
        <DramaMediaActionProvider controller={media} projectId={projectId} revision={summary?.production.revision} episodeId={routeEpisodeId}>
            <WorkspacePage className="drama-root drama-workflow-page" fluid scroll={false}>
                <DramaProjectTopbar
                    name={summary?.project.name || "短剧制作"}
                    stage={managing ? "作品管理" : routeEpisodeId ? "单集创作" : "短剧创作"}
                    controls={
                        managing ? (
                            <nav className="drama-workflow-management-tabs" aria-label="作品管理">
                                {[
                                    { key: "script", label: "剧本设定" },
                                    { key: "style", label: "风格设置" },
                                    { key: "assets", label: "主体资产" },
                                    { key: "episodes", label: "分集管理" },
                                ].map((tab) => (
                                    <button key={tab.key} type="button" aria-current={managementTab === tab.key ? "page" : undefined} disabled={confirm.isPending || saveStyle.isPending} onClick={() => openManagement(tab.key)}>
                                        {tab.label}
                                    </button>
                                ))}
                            </nav>
                        ) : (
                            <nav className="drama-workflow-steps" aria-label="短剧制作步骤">
                                {steps.map((step, index) => {
                                    const allowed = summary ? isWorkflowStepAllowed(summary, step.key, { manualPreview: step.key === "preview" }) : false;
                                    const passed = index < steps.findIndex((item) => item.key === active);
                                    return (
                                        <div key={step.key} className="drama-workflow-step-item">
                                            {index ? <ChevronRight aria-hidden="true" /> : null}
                                            <button type="button" aria-current={active === step.key ? "step" : undefined} data-passed={passed || undefined} disabled={!allowed || confirm.isPending || saveStyle.isPending} onClick={() => openStep(step.key)}>
                                                {step.title}
                                            </button>
                                        </div>
                                    );
                                })}
                            </nav>
                        )
                    }
                >
                    <Button type="text" icon={<FolderKanban className="size-4" />} disabled={confirm.isPending || saveStyle.isPending} onClick={() => openManagement("episodes")}>
                        {managing ? "选择分集" : "作品管理"}
                    </Button>
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                {
                                    key: "advanced",
                                    disabled: confirm.isPending || saveStyle.isPending,
                                    label: (
                                        <span className="drama-workflow-advanced-menu">
                                            <strong>高级制作台</strong>
                                            <small>分集维护、任务处理与制作设置</small>
                                        </span>
                                    ),
                                    onClick: () => {
                                        if (confirm.isPending || saveStyle.isPending) return;
                                        if (otherSettingsDirty || sourceState.dirty || sourceState.busy) {
                                            message.info("请先保存或放弃当前修改，再打开高级制作台");
                                            return;
                                        }
                                        navigate(dramaStudioPath(projectId, routeEpisodeId || searchParams.get("episode") || undefined, searchParams, "advanced"));
                                    },
                                },
                            ],
                        }}
                    >
                        <Button type="text" icon={<MoreHorizontal className="size-4" />} disabled={confirm.isPending || saveStyle.isPending} aria-label="更多操作">
                            更多
                        </Button>
                    </Dropdown>
                </DramaProjectTopbar>
                {summaryQuery.isLoading ? <WorkspaceLoadingState label="正在读取短剧" /> : null}
                {summaryQuery.isError ? <WorkspaceErrorState title="短剧暂时无法读取" description={summaryQuery.error instanceof Error ? summaryQuery.error.message : "请重试"} onRetry={refresh} /> : null}
                {summary && settings ? (
                    <>
                        <div className="drama-workflow-body app-workspace-scroll">
                            {episodeStyleId && episodeStyleQuery.isError ? (
                                <WorkspaceErrorState compact title="本集配置读取失败" description="请重新读取后再编辑或生成。" onRetry={() => void episodeStyleQuery.refetch()} />
                            ) : episodeConfigurationBusy ? (
                                <WorkspaceLoadingState label="正在读取本集配置" rows={1} />
                            ) : null}
                            {episodesView ? (
                                <WorkflowEpisodes
                                    summary={summary}
                                    busy={chapterPickerOpen || confirm.isPending || saveStyle.isPending}
                                    onChanged={refresh}
                                    onDirtyChange={sourceChanged}
                                    onPickChapters={summary.production.reservedChapterCount ? openChapterPicker : undefined}
                                    onOpenEpisode={(episodeId, step = "review") => navigate(`/projects/${encodeURIComponent(projectId)}/e/${encodeURIComponent(episodeId)}?step=${step}`)}
                                />
                            ) : null}
                            {!episodesView && (active === "source" || active === "review") ? (
                                <WorkflowSourceReview
                                    summary={summary}
                                    step={active}
                                    episodeId={episodeStyleId}
                                    busy={confirm.isPending}
                                    onChanged={refresh}
                                    onPickChapters={summary.production.reservedChapterCount ? openChapterPicker : undefined}
                                    onDirtyChange={sourceChanged}
                                    onContinue={() => {
                                        const params = new URLSearchParams(searchParams);
                                        if (managing) {
                                            params.delete("step");
                                            params.set("manage", "style");
                                        } else {
                                            params.delete("manage");
                                            params.set("step", "style");
                                        }
                                        confirmedNavigation.current = `?${params}`;
                                        setSearchParams(params, { replace: true });
                                    }}
                                />
                            ) : null}
                            {active === "style" ? (
                                <>
                                    {episodeStyleId && episodeStyle ? (
                                        <p className="drama-workflow-notice">第 {summary.episodes.find((episode) => episode.id === episodeStyleId)?.number || "当前"} 集配置；修改仅作用于本集，已有产物保持当前版本。</p>
                                    ) : !episodeStyleId ? (
                                        <p className="drama-workflow-notice">首次配置作为各集初始值；后续每集可单独修改，已有集保持各自配置。</p>
                                    ) : null}
                                    {settingsStale ? (
                                        <p className="drama-workflow-notice" role="alert">
                                            服务端配置已更新，当前调整基于旧版本，未覆盖你的修改。请重新载入后再继续。
                                            <Button size="small" type="link" onClick={() => setSettingsDraft(null)}>
                                                重新载入
                                            </Button>
                                        </p>
                                    ) : null}
                                    {!episodeStyleId || (episodeStyle && !episodeStyleQuery.isError) ? (
                                        <WorkflowConfiguration
                                            ref={configuration}
                                            summary={summary}
                                            settings={settings}
                                            disabled={confirm.isPending || saveStyle.isPending || settingsStale || episodeConfigurationBusy}
                                            styleOnly={stage !== "configuring" && !episodeStyleId}
                                            scope={episodeStyleId ? "episode" : "project"}
                                            onChange={(value) => {
                                                if (settingsDraft && settingsDraft.revision !== revision) return;
                                                if (!savedSettings || (episodeStyleId && !episodeStyle)) return;
                                                setConfigurationSyncError("");
                                                if (failedConfiguration.current !== JSON.stringify(dramaGenerationConfiguration(value))) failedConfiguration.current = "";
                                                setSettingsDraft({
                                                    value,
                                                    baseline: settingsDraft?.baseline || savedSettings,
                                                    revision: settingsDraft?.revision || revision,
                                                    ...(episodeStyle ? { episodeRevision: settingsDraft?.episodeRevision ?? episodeStyle.episodeRevision } : {}),
                                                });
                                            }}
                                        />
                                    ) : null}
                                    {stage !== "configuring" && !episodeStyleId ? <WorkflowImpact projectId={projectId} revision={revision} /> : null}
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
                                        variant={managing ? "library" : "episode"}
                                        episodeId={managing ? undefined : routeEpisodeId || searchParams.get("episode") || undefined}
                                        onEpisodeChange={(episodeId) => {
                                            const next = new URLSearchParams(searchParams);
                                            next.delete("episode");
                                            next.delete("manage");
                                            next.set("step", "assets");
                                            navigate(`/projects/${encodeURIComponent(projectId)}/e/${encodeURIComponent(episodeId)}?${next}`, { replace: true });
                                        }}
                                        summary={episodeSummary!}
                                        cast={castQuery.cast}
                                        busy={confirm.isPending || media.state.submitting || retryText.isPending || episodeConfigurationBusy}
                                        loading={castQuery.isLoading}
                                        error={castQuery.error}
                                        onRetry={() => void castQuery.refetch()}
                                        onChanged={refresh}
                                        onPickChapters={summary.production.reservedChapterCount ? openChapterPicker : undefined}
                                        onGenerate={(cast, selectedId) => {
                                            if (!episodeConfigurationBusy) media.requestCastImage(cast, selectedId || episodeStyleId);
                                        }}
                                        onDirtyChange={sourceChanged}
                                        onContinue={stage === "assets" ? () => setModeOpen(true) : undefined}
                                        continueDisabled={!canConfirm}
                                        continuing={confirm.isPending}
                                    />
                                </div>
                            ) : null}
                            {!episodesView && (active === "story" || active === "preview") ? (
                                <WorkflowProduction
                                    summary={episodeSummary!}
                                    step={active}
                                    onChanged={refresh}
                                    onPickChapters={summary.production.reservedChapterCount ? openChapterPicker : undefined}
                                    busy={chapterPickerState.busy || confirm.isPending || saveStyle.isPending || episodeConfigurationBusy}
                                    onDirtyChange={sourceChanged}
                                    onAllowMediaNavigation={(next) => {
                                        confirmedMediaNavigation.current = next;
                                    }}
                                    embedded
                                />
                            ) : null}
                            {active === "assets" ? (
                                <QueueBar
                                    projectId={projectId}
                                    summary={summary}
                                    onJump={(job) => {
                                        if (!episodeConfigurationBusy && job.kind === "cast_image" && job.shotId) setEditingCast(job.shotId);
                                    }}
                                />
                            ) : null}
                        </div>
                        {!episodesView && (footerStatus || hasFooterAction) ? (
                            <footer className="drama-workflow-footer" aria-label="制作流程引导">
                                {footerStatus}
                                {settingsStale ? (
                                    <Button onClick={() => setSettingsDraft(null)}>重新载入配置</Button>
                                ) : active === "style" && (stage !== "configuring" || episodeStyleId) ? (
                                    <>
                                        {otherSettingsDirty ? (
                                            <Button disabled={saveStyle.isPending} onClick={() => setSettingsDraft(null)}>
                                                放弃修改
                                            </Button>
                                        ) : null}
                                        <Button
                                            type="primary"
                                            disabled={saveStyle.isPending || episodeConfigurationBusy || (episodeStyleId ? Boolean(configIssue || episodeStyleIssue) : !settings?.styleName.trim() || !settings?.stylePrompt.trim())}
                                            loading={saveStyle.isPending}
                                            onClick={() => (settingsDirty && settingsDraft ? saveStyle.mutate({ ticket: operation.capture(), draft: settingsDraft }) : continueToAssets())}
                                        >
                                            {otherSettingsDirty ? "保存并继续" : managing ? "继续：主体资产" : "继续：角色场景"}
                                        </Button>
                                    </>
                                ) : active === "source" ? (
                                    <Button type="primary" icon={<ArrowRight className="size-4" />} disabled={sourceState.dirty || sourceState.busy || !summary.production.chapterCount} onClick={() => openStep("review")}>
                                        下一步：剧本格式
                                    </Button>
                                ) : active === "review" && (managing || routeEpisodeId || stage !== "configuring") ? (
                                    <Button type="primary" icon={<ArrowRight className="size-4" />} disabled={sourceState.dirty || sourceState.busy || !summary.production.chapterCount} onClick={() => openStep("style")}>
                                        下一步：风格设置
                                    </Button>
                                ) : stage === "configuring" && active === "style" ? (
                                    <Button type="primary" disabled={!canConfirm || Boolean(configIssue)} loading={confirm.isPending} onClick={() => confirm.mutate({ expectedStep: "configuring", ticket: operation.capture() })}>
                                        下一步：角色场景
                                    </Button>
                                ) : stage === "assets" && active === "assets" ? null : stage === "story" && active === "story" ? (
                                    <Button type="primary" disabled={!canConfirm} loading={confirm.isPending} onClick={() => confirm.mutate({ expectedStep: "story", ticket: operation.capture() })}>
                                        完成分镜编排
                                    </Button>
                                ) : null}
                                {active === "style" && (initialConfiguration || episodeStyleId) && configIssue ? (
                                    <span role="alert">
                                        当前视频模型{configIssue}，请先调整后再确认。
                                        <Button type="link" size="small" onClick={() => configuration.current?.focusIssue()}>
                                            去修改
                                        </Button>
                                    </span>
                                ) : null}
                                {active === "style" && episodeStyleIssue ? <span role="alert">{episodeStyleIssue}</span> : null}
                            </footer>
                        ) : null}
                    </>
                ) : null}
                {episodeSummary && editingCast ? <CastEditorDialog summary={episodeSummary} cast={castQuery.cast} castId={editingCast} episodeId={episodeStyleId} onClose={() => setEditingCast(undefined)} onChanged={refresh} /> : null}
                {summary && chapterPickerOpen ? (
                    <ChapterPickerModal
                        open
                        summary={summary}
                        blockedReason={stage === "configuring" ? "请先在剧本格式中选择制作范围并确认风格" : !summary.production.planDone ? "前面的章节还在分集规划，完成后再加入" : undefined}
                        busy={chapterPickerBusy}
                        onClose={() => setChapterPickerOpen(false)}
                        onDirtyChange={chapterPickerChanged}
                        onProduced={async () => {
                            setChapterPickerOpen(false);
                            await queryClient.invalidateQueries({ queryKey: ["drama", projectId] });
                        }}
                    />
                ) : null}
                {summary ? (
                    <WorkflowModeDialog
                        open={modeOpen}
                        summary={summary}
                        onCancel={() => setModeOpen(false)}
                        onConfirm={(modeSettings) => confirm.mutateAsync({ expectedStep: "assets", ticket: operation.capture(), modeSettings })}
                        onGenerationStateChange={modeGenerationChanged}
                        registerGenerationFlush={registerModeGenerationFlush}
                    />
                ) : null}
                <DramaMediaActionDialog controller={media} />
                <AppModal
                    open={
                        blocker.state === "blocked" &&
                        (otherSettingsDirty || sourceState.dirty || (sourceState.busy && !sourceEditorState.automatic) || settingsStale || (generationDirty && Boolean(configIssue || episodeConfigurationBusy || configurationSyncError)))
                    }
                    title={saveStyle.isPending ? "风格正在保存" : "当前修改尚未保存"}
                    onCancel={() => blocker.reset?.()}
                    footer={[
                        <Button key="stay" onClick={() => blocker.reset?.()}>
                            继续编辑
                        </Button>,
                        <Button
                            key="leave"
                            danger
                            disabled={saveStyle.isPending}
                            onClick={() => {
                                if (saveStyle.isPending) return;
                                setSettingsDraft(null);
                                blocker.proceed?.();
                            }}
                        >
                            放弃修改并离开
                        </Button>,
                    ]}
                >
                    <p>{saveStyle.isPending ? "请等待风格保存完成后再离开。保存成功后将进入当前范围的主体页。" : "离开后未保存的正文、范围或配置将丢失。正在提交的操作仍可能在服务端完成。"}</p>
                </AppModal>
            </WorkspacePage>
        </DramaMediaActionProvider>
    );
}
