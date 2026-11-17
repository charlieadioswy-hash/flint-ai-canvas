import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, Select } from "antd";
import { ArrowRight, ChevronLeft, ChevronRight, Gem, MapPinned, Plus, ScanText, UsersRound } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { createDramaCast, deleteDramaCast, extractDramaCast, getDramaEpisodeStyle, listDramaJobs, type DramaCast, type DramaCastKind, type DramaJob, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { CAST_KIND_LABEL } from "./drama-shared";
import { GuideAssets } from "./guide-panels";
import { DramaMediaEpisodeScope } from "./studio/drama-media-action-context";
import { WorkflowAssetScope } from "./workflow-asset-scope";
import { WorkflowAssetLibrary } from "./workflow-asset-library";
import { WorkflowBatch } from "./workflow-batch";
import { WorkflowCharacterLibrary, type WorkflowCharacterLibraryControls } from "./workflow-character-library";
import { CastEditorDialog } from "./studio/cast-editor-dialog";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { dramaKeys } from "./studio/use-studio";
import "./workflow-assets.css";

const KINDS = ["character", "scene", "prop"] as const satisfies readonly DramaCastKind[];

export type WorkflowAssetsProps = {
    variant?: "library" | "episode";
    episodeId?: string;
    onEpisodeChange?: (episodeId: string) => void;
    summary: DramaSummary;
    cast: DramaCast[];
    loading?: boolean;
    busy?: boolean;
    error?: unknown;
    onRetry?: () => void;
    onChanged: () => void;
    onGenerate: (cast: DramaCast, episodeId?: string) => void;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
    onContinue?: () => void;
    continueDisabled?: boolean;
    continuing?: boolean;
};

type AddDraft = { name: string };

function belongsToProject(item: DramaCast, projectId: string) {
    return item.projectId === projectId;
}

export function WorkflowAssets(props: WorkflowAssetsProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <WorkflowAssetsSession key={`${userId}:${props.summary.project.id}:${props.variant || "episode"}:${props.episodeId || ""}`} {...props} />;
}

function WorkflowAssetsSession({
    summary,
    cast,
    variant = "episode",
    episodeId,
    onEpisodeChange,
    loading = false,
    busy = false,
    error,
    onRetry,
    onChanged,
    onGenerate,
    onDirtyChange,
    onContinue,
    continueDisabled = false,
    continuing = false,
}: WorkflowAssetsProps) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const userId = useUserStore((state) => state.user?.id || "");
    const projectId = summary.project.id;
    const revision = summary.production.revision;
    const guideStep = summary.guide?.step || summary.production.guideStep;
    const assetEditBlocked = guideStep === "configuring";
    const extractionStageBlocked = summary.production.stage === "bible" || Boolean(guideStep && !["assets", "story", "completed"].includes(guideStep));
    const operation = useDramaOperationScope(projectId);
    const [deleteDraft, setDeleteDraft] = useState<{ cast: DramaCast; revision: number; ticket: ReturnType<typeof operation.capture> }>();
    const [kind, setKind] = useState<DramaCastKind>("character");
    const [localEpisodeId, setLocalEpisodeId] = useState(() => summary.episodes.toSorted((left, right) => left.number - right.number)[0]?.id || "");
    const [addOpen, setAddOpen] = useState(false);
    const [addKind, setAddKind] = useState<DramaCastKind>("character");
    const [addDraft, setAddDraft] = useState<AddDraft>({ name: "" });
    const [created, setCreated] = useState<DramaCast>();
    const [editingId, setEditingId] = useState<string>();
    const [libraryStates, setLibraryStates] = useState<Partial<Record<DramaCastKind, { dirty: boolean; busy: boolean }>>>({});
    const [editorState, setEditorState] = useState({ dirty: false, busy: false });
    const [batchActivity, setBatchActivity] = useState<Partial<Record<DramaCastKind, boolean>>>({});
    const [extractingKinds, setExtractingKinds] = useState<Partial<Record<DramaCastKind, boolean>>>({});
    const extractionLocks = useRef(new Set<DramaCastKind>());
    const activeExtractionIds = useRef(new Set<string>());
    const mutationLock = useRef(false);
    const latest = useRef({ onChanged, onGenerate, onDirtyChange });

    const projectCast = cast.filter((item) => belongsToProject(item, projectId));
    const counts = Object.fromEntries(KINDS.map((item) => [item, projectCast.filter((entry) => entry.kind === item && !entry.parentId).length])) as Record<DramaCastKind, number>;
    const episodes = summary.episodes.filter((episode) => episode.id).toSorted((left, right) => left.number - right.number);
    const selectedEpisodeId = episodeId ?? localEpisodeId;
    const configurationEpisodeId = variant === "episode" ? selectedEpisodeId : "";
    const episodeSettingsQuery = useQuery({
        queryKey: ["drama-episode-style", userId, projectId, configurationEpisodeId, revision],
        queryFn: ({ signal }) => getDramaEpisodeStyle(projectId, configurationEpisodeId, signal),
        enabled: Boolean(configurationEpisodeId),
    });
    const episodeConfiguration = episodeSettingsQuery.data?.episodeId === configurationEpisodeId && episodeSettingsQuery.data.projectId === projectId ? episodeSettingsQuery.data : undefined;
    const configurationBusy = variant === "episode" && (!episodeConfiguration || episodeSettingsQuery.isError);
    const effectiveSettings = variant === "episode" ? episodeConfiguration?.settings || summary.production.settings : summary.production.settings;
    const assetSummary = effectiveSettings === summary.production.settings ? summary : { ...summary, production: { ...summary.production, settings: effectiveSettings } };
    const episodeIndex = episodes.findIndex((episode) => episode.id === selectedEpisodeId);
    const extractionJobs = useQuery({
        queryKey: dramaKeys.jobs(projectId),
        queryFn: ({ signal }) => listDramaJobs(projectId, 120, signal),
        enabled: !extractionStageBlocked,
        refetchInterval: (query) => (query.state.status === "error" || query.state.data?.jobs.some((job) => job.status === "queued" || job.status === "running") || summary.jobCounts.queued || summary.jobCounts.running ? 2_500 : false),
    });
    const activeTextJobs = (extractionJobs.data?.jobs || []).filter((job) => ["bible", "plan", "script", "segment_prompt"].includes(job.kind) && (job.status === "queued" || job.status === "running"));
    const otherTextJobs = activeTextJobs.filter((job) => job.kind !== "bible" || !job.assetKind);
    useEffect(() => {
        if (created && cast.some((item) => item.id === created.id && item.projectId === projectId)) setCreated(undefined);
    }, [cast, created, projectId]);
    const editorCast = created && created.projectId === projectId && !projectCast.some((item) => item.id === created.id) ? [...projectCast, created] : projectCast;
    const locked = busy || configurationBusy;

    const refreshProject = (ticket: ReturnType<typeof operation.capture>) => {
        if (!operation.isCurrent(ticket)) return;
        void queryClient.invalidateQueries({ queryKey: dramaKeys.summary(ticket.projectId) });
        void queryClient.invalidateQueries({ queryKey: dramaKeys.cast(ticket.projectId) });
        void queryClient.invalidateQueries({ queryKey: dramaKeys.chapters(ticket.projectId) });
        latest.current.onChanged();
    };
    useEffect(() => {
        if (!extractionJobs.data || extractionJobs.isError) return;
        let finished = false;
        for (const job of extractionJobs.data.jobs) {
            if (job.kind !== "bible" || !job.assetKind) continue;
            if (job.status === "queued" || job.status === "running") activeExtractionIds.current.add(job.id);
            else if (activeExtractionIds.current.delete(job.id)) finished = true;
        }
        if (finished) refreshProject(operation.capture());
    }, [extractionJobs.data, extractionJobs.isError]);

    const create = useMutation({
        mutationFn: async (input: { kind: DramaCastKind; name: string; expectedRevision: number; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            const name = input.name.trim();
            if (!name) throw new Error("请填写名称");
            if (name.length > 60) throw new Error("名称不能超过 60 字");
            return createDramaCast(input.ticket.projectId, { kind: input.kind, name, expectedRevision: input.expectedRevision, ...(configurationEpisodeId ? { episodeId: configurationEpisodeId } : {}) });
        },
        onSuccess: ({ cast: createdCast }, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            setCreated(createdCast);
            setEditingId(createdCast.id);
            setAddDraft({ name: "" });
            setAddOpen(false);
            refreshProject(input.ticket);
            message.success(variant === "episode" ? "已新增本集资产，可继续编辑文字设定" : "已保存到作品资产，可继续编辑文字设定");
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            message.error(error instanceof Error ? error.message : "新增失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });

    const remove = useMutation({
        mutationFn: async (input: NonNullable<typeof deleteDraft>) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            return deleteDramaCast(input.ticket.projectId, input.cast.id, input.revision);
        },
        onSuccess: (_, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            setDeleteDraft(undefined);
            refreshProject(input.ticket);
            message.success(`已删除${CAST_KIND_LABEL[input.cast.kind]}「${input.cast.name}」`);
        },
        onError: (error, input) => {
            if (operation.isCurrent(input.ticket)) message.error(error instanceof Error ? error.message : "删除失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });
    const extract = useMutation({
        mutationFn: async (input: { kind: DramaCastKind; expectedRevision: number; episodeId?: string; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            return extractDramaCast(input.ticket.projectId, { expectedRevision: input.expectedRevision, kind: input.kind, ...(input.episodeId ? { episodeIds: [input.episodeId] } : { allChapters: true }) });
        },
        onSuccess: async (result, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            await queryClient.cancelQueries({ queryKey: dramaKeys.jobs(input.ticket.projectId), exact: true });
            if (!operation.isCurrent(input.ticket)) return;
            activeExtractionIds.current.add(result.job.id);
            queryClient.setQueryData<{ jobs: DramaJob[] }>(dramaKeys.jobs(input.ticket.projectId), (previous) => ({ jobs: [result.job, ...(previous?.jobs || []).filter((job) => job.id !== result.job.id)] }));
            refreshProject(input.ticket);
            message.success(`已提交全部${CAST_KIND_LABEL[input.kind]}提取，请在任务队列查看进度`);
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            refreshProject(input.ticket);
            message.error(error instanceof Error ? error.message : "资产提取失败，请重试");
        },
        onSettled: (_, __, input) => {
            extractionLocks.current.delete(input.kind);
            if (operation.isCurrent(input.ticket)) setExtractingKinds((previous) => ({ ...previous, [input.kind]: false }));
        },
    });
    const pending = create.isPending || remove.isPending;
    const extractionSubmitting = KINDS.some((kind) => extractingKinds[kind]);
    const libraryState = { dirty: KINDS.some((kind) => libraryStates[kind]?.dirty), busy: KINDS.some((kind) => libraryStates[kind]?.busy) };
    const batchBusy = KINDS.some((kind) => batchActivity[kind]);
    const editingFrozen = locked || pending || Boolean(deleteDraft) || libraryState.busy || editorState.busy || batchBusy;
    const frozen = editingFrozen || extractionSubmitting;
    const assetFrozen = frozen || assetEditBlocked;
    latest.current = { onChanged, onGenerate, onDirtyChange };
    const dirty = Boolean(addDraft.name.trim()) || libraryState.dirty || editorState.dirty;
    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, pending || extractionSubmitting || locked || Boolean(deleteDraft) || libraryState.busy || editorState.busy || batchBusy);
    }, [dirty, pending, extractionSubmitting, locked, deleteDraft, libraryState.busy, editorState.busy, batchBusy]);
    useEffect(() => () => latest.current.onDirtyChange?.(false, false), []);
    const reportLibraryState = (kind: DramaCastKind, dirty: boolean, busy: boolean) => setLibraryStates((previous) => (previous[kind]?.dirty === dirty && previous[kind]?.busy === busy ? previous : { ...previous, [kind]: { dirty, busy } }));
    const libraryBlocked = (kind: DramaCastKind) => locked || pending || extractionSubmitting || Boolean(deleteDraft) || assetEditBlocked || editorState.busy || batchBusy || KINDS.some((other) => other !== kind && libraryStates[other]?.busy);

    const submitAdd = () => {
        if (assetFrozen || mutationLock.current) return;
        mutationLock.current = true;
        const expectedRevision = revision;
        const ticket = operation.capture();
        create.mutate({ kind: addKind, name: addDraft.name, expectedRevision, ticket });
    };

    const openAdd = (nextKind: DramaCastKind) => {
        if (assetFrozen) return;
        if (addDraft.name.trim() && addKind !== nextKind) {
            message.info(`请先保存或取消正在新增的${CAST_KIND_LABEL[addKind]}`);
            return;
        }
        setAddKind(nextKind);
        setAddOpen(true);
    };
    const selectEpisode = (id: string) => {
        if (frozen || dirty || editingId || !episodes.some((episode) => episode.id === id)) return;
        if (onEpisodeChange) onEpisodeChange(id);
        else setLocalEpisodeId(id);
    };
    const openDelete = (item: DramaCast) => {
        if (assetFrozen || !projectCast.some((current) => current.id === item.id && !current.parentId)) return;
        if (dirty || editingId) {
            message.info("请先保存或取消当前修改，再删除资产");
            return;
        }
        remove.reset();
        setDeleteDraft({ cast: item, revision, ticket: operation.capture() });
    };
    const deleteStale = Boolean(deleteDraft && (deleteDraft.revision !== revision || !projectCast.some((item) => item.id === deleteDraft.cast.id) || !operation.isCurrent(deleteDraft.ticket)));
    const submitDelete = () => {
        if (!deleteDraft || deleteStale || mutationLock.current || locked || pending || assetEditBlocked || libraryState.busy || editorState.busy || batchBusy) return;
        mutationLock.current = true;
        remove.mutate(deleteDraft);
    };
    const extractionBlocked =
        busy ||
        pending ||
        Boolean(deleteDraft) ||
        libraryState.busy ||
        editorState.busy ||
        batchBusy ||
        assetEditBlocked ||
        loading ||
        dirty ||
        Boolean(editingId) ||
        extractionStageBlocked ||
        (variant === "episode" && !episodes.some((episode) => episode.id === selectedEpisodeId)) ||
        extractionJobs.isPending ||
        extractionJobs.isError ||
        otherTextJobs.length > 0;
    const kindExtracting = (kind: DramaCastKind) => Boolean(extractingKinds[kind]) || activeTextJobs.some((job) => job.kind === "bible" && job.assetKind === kind);
    const submitExtraction = (kind: DramaCastKind) => {
        if (extractionBlocked || mutationLock.current || extractionLocks.current.has(kind) || kindExtracting(kind)) return;
        extractionLocks.current.add(kind);
        setExtractingKinds((previous) => ({ ...previous, [kind]: true }));
        extract.mutate({ kind, expectedRevision: revision, episodeId: configurationEpisodeId || undefined, ticket: operation.capture() });
    };
    const renderExtraction = (kind: DramaCastKind) => {
        const extracting = kindExtracting(kind);
        return (
            <Button
                size="small"
                icon={<ScanText className="size-3.5" aria-hidden />}
                aria-label={`提取全部${CAST_KIND_LABEL[kind]}`}
                aria-busy={extracting}
                title={
                    extractionStageBlocked
                        ? "请先完成首次资产提取"
                        : extractionJobs.isError
                          ? "任务状态暂时读取失败，正在自动更新"
                          : otherTextJobs.length
                            ? "请等待当前文字任务完成"
                            : variant === "episode"
                              ? `从当前集原文提取全部${CAST_KIND_LABEL[kind]}，保留已有资产设定和图片`
                              : `从作品全部原文提取${CAST_KIND_LABEL[kind]}，保留已有资产设定和图片`
                }
                loading={extracting}
                disabled={extractionBlocked || extracting}
                onClick={() => submitExtraction(kind)}
            >
                {extracting ? `正在提取${CAST_KIND_LABEL[kind]}…` : `提取全部${CAST_KIND_LABEL[kind]}`}
            </Button>
        );
    };

    const renderAssets = (libraryControls: WorkflowCharacterLibraryControls) => (
        <section className={`drama-workflow-assets is-${variant}`} aria-label="主体资产">
            <header className="drama-workflow-assets-head">
                <div className="drama-workflow-assets-heading">
                    <h2>{variant === "library" ? "主体资产" : "主体管理"}</h2>
                    {variant === "episode" ? (
                        <nav className="drama-workflow-assets-episode-nav" aria-label="主体管理选集">
                            <Button
                                type="text"
                                icon={<ChevronLeft className="size-4" />}
                                aria-label="上一集主体资产"
                                disabled={frozen || dirty || Boolean(editingId) || episodeIndex <= 0}
                                onClick={() => selectEpisode(episodes[episodeIndex - 1]?.id || "")}
                            />
                            <Select
                                aria-label="主体管理剧集"
                                value={selectedEpisodeId || undefined}
                                placeholder="暂无剧集"
                                disabled={frozen || dirty || Boolean(editingId) || !episodes.length}
                                onChange={selectEpisode}
                                options={episodes.map((episode) => ({ value: episode.id, label: `第${episode.number}集`, title: episode.title }))}
                            />
                            <Button
                                type="text"
                                icon={<ChevronRight className="size-4" />}
                                aria-label="下一集主体资产"
                                disabled={frozen || dirty || Boolean(editingId) || episodeIndex < 0 || episodeIndex >= episodes.length - 1}
                                onClick={() => selectEpisode(episodes[episodeIndex + 1]?.id || "")}
                            />
                        </nav>
                    ) : null}
                </div>
                <div className="drama-workflow-assets-actions">
                    {variant === "library" ? (
                        <Button icon={<Plus className="size-3.5" />} disabled={assetFrozen} onClick={() => openAdd(kind)}>
                            新增{CAST_KIND_LABEL[kind]}
                        </Button>
                    ) : null}
                    {onContinue ? (
                        <Button type="primary" icon={<ArrowRight className="size-3.5" />} disabled={continueDisabled || frozen || dirty} loading={continuing} onClick={onContinue}>
                            编排剧本
                        </Button>
                    ) : null}
                </div>
            </header>

            {assetEditBlocked ? <p role="status">请先完成风格设置，进入角色场景后再新增或编辑资产。</p> : null}
            {variant === "episode" && episodeSettingsQuery.isError ? (
                <p role="alert">
                    本集配置读取失败，暂不能修改或生成资产。<Button onClick={() => void episodeSettingsQuery.refetch()}>重新读取</Button>
                </p>
            ) : configurationBusy ? (
                <p role="status">{configurationEpisodeId ? "正在读取本集配置…" : "请先创建或选择剧集"}</p>
            ) : null}

            {variant === "library" ? (
                <div className="drama-workflow-assets-library-toolbar">
                    <div className="drama-workflow-assets-tabs" role="group" aria-label="主体资产分类">
                        {KINDS.map((item) => (
                            <button key={item} type="button" aria-pressed={kind === item} disabled={(editingFrozen || libraryState.dirty) && kind !== item} onClick={() => setKind(item)}>
                                {CAST_KIND_LABEL[item]}
                                <span>{counts[item]}</span>
                            </button>
                        ))}
                    </div>
                    <div className="drama-workflow-assets-actions">
                        {renderExtraction(kind)}
                        {kind === "character" ? (
                            libraryControls.importTrigger
                        ) : (
                            <WorkflowAssetLibrary key={kind} projectId={projectId} kind={kind} cast={projectCast} busy={libraryBlocked(kind)} onChanged={onChanged} onDirtyChange={(dirty, busy) => reportLibraryState(kind, dirty, busy)} />
                        )}
                    </div>
                </div>
            ) : null}

            {addOpen ? (
                <form
                    className="drama-workflow-assets-add"
                    aria-label={`快速新增${CAST_KIND_LABEL[addKind]}`}
                    onSubmit={(event) => {
                        event.preventDefault();
                        submitAdd();
                    }}
                >
                    <fieldset disabled={frozen}>
                        <legend>快速新增{CAST_KIND_LABEL[addKind]}</legend>
                        <p>先保存名称，再补充文字设定。这里不会猜测描述或开始生成图片。</p>
                        <label>
                            名称
                            <Input aria-label="资产名称" disabled={assetEditBlocked} maxLength={60} value={addDraft.name} onChange={(event) => setAddDraft((current) => ({ ...current, name: event.target.value }))} />
                        </label>
                        <div className="drama-workflow-assets-actions">
                            <Button
                                htmlType="button"
                                disabled={create.isPending}
                                onClick={() => {
                                    setAddOpen(false);
                                    setAddDraft({ name: "" });
                                }}
                            >
                                取消
                            </Button>
                            <Button htmlType="submit" type="primary" loading={create.isPending} disabled={assetFrozen || !addDraft.name.trim()}>
                                保存资产
                            </Button>
                        </div>
                    </fieldset>
                </form>
            ) : null}

            <div className="drama-workflow-assets-results" aria-label="角色、场景与道具列表">
                {error ? (
                    <p role="alert">
                        资产读取失败，已加载的设定会保留。<Button onClick={onRetry || onChanged}>重试</Button>
                    </p>
                ) : null}
                {loading && !counts[kind] ? (
                    <p className="drama-workflow-assets-status" role="status">
                        正在读取本作品资产
                    </p>
                ) : null}
                <DramaMediaEpisodeScope episodeId={configurationEpisodeId || undefined}>
                    <WorkflowAssetScope
                        key={variant}
                        summary={summary}
                        cast={projectCast}
                        kind={variant === "library" ? kind : undefined}
                        episodeId={variant === "episode" ? selectedEpisodeId : undefined}
                        showToolbar={variant === "library"}
                        busy={assetFrozen}
                        onChanged={onChanged}
                    >
                        {(visible, refreshing) => (
                            <div className="drama-workflow-assets-columns">
                                {(variant === "library" ? [kind] : KINDS).map((columnKind) => (
                                    <WorkflowAssetColumn
                                        key={`${selectedEpisodeId}:${columnKind}`}
                                        summary={assetSummary}
                                        episodeId={configurationEpisodeId || undefined}
                                        kind={columnKind}
                                        cast={visible.filter((item) => item.kind === columnKind)}
                                        busy={assetFrozen || refreshing}
                                        loading={loading}
                                        selectable={variant === "episode"}
                                        extractionAction={variant === "episode" ? renderExtraction(columnKind) : undefined}
                                        headerActions={
                                            variant === "episode" ? (
                                                columnKind === "character" ? (
                                                    libraryControls.importTrigger
                                                ) : (
                                                    <WorkflowAssetLibrary
                                                        projectId={projectId}
                                                        episodeId={configurationEpisodeId || undefined}
                                                        kind={columnKind}
                                                        cast={projectCast}
                                                        busy={libraryBlocked(columnKind) || refreshing}
                                                        onChanged={() => refreshProject(operation.capture())}
                                                        onDirtyChange={(dirty, busy) => reportLibraryState(columnKind, dirty, busy)}
                                                    />
                                                )
                                            ) : null
                                        }
                                        onBusyChange={(busy) => setBatchActivity((previous) => (previous[columnKind] === busy ? previous : { ...previous, [columnKind]: busy }))}
                                        onChanged={onChanged}
                                        onAdd={() => openAdd(columnKind)}
                                        onEdit={(item) => {
                                            if (!assetFrozen) setEditingId(item.id);
                                        }}
                                        onGenerate={(item) => {
                                            if (!assetFrozen) onGenerate(item, configurationEpisodeId || undefined);
                                        }}
                                        onDelete={openDelete}
                                        onSaveToLibrary={libraryControls.saveToLibrary}
                                    />
                                ))}
                            </div>
                        )}
                    </WorkflowAssetScope>
                </DramaMediaEpisodeScope>
            </div>

            <AppModal
                open={Boolean(deleteDraft)}
                title={deleteDraft ? `删除「${deleteDraft.cast.name}」？` : "删除资产"}
                rootClassName="drama-root"
                okText="确认删除"
                cancelText="取消"
                confirmLoading={remove.isPending}
                okButtonProps={{ danger: true, disabled: deleteStale || locked || assetEditBlocked || create.isPending || libraryState.busy || editorState.busy || batchBusy }}
                cancelButtonProps={{ disabled: remove.isPending }}
                maskClosable={!remove.isPending}
                keyboard={!remove.isPending}
                closable={!remove.isPending}
                onCancel={() => {
                    if (!remove.isPending) setDeleteDraft(undefined);
                }}
                onOk={submitDelete}
            >
                <p>将从整个作品中移除此资产。已被镜头等内容使用的资产无法删除。</p>
                {deleteStale ? <p role="alert">作品内容已更新，请关闭后重新选择要删除的资产。</p> : remove.isError ? <p role="alert">{remove.error instanceof Error ? remove.error.message : "删除失败，请重试"}</p> : null}
            </AppModal>
            <CastEditorDialog
                summary={assetSummary}
                episodeId={configurationEpisodeId || undefined}
                cast={editorCast}
                castId={editingId}
                onDirtyChange={(dirty, busy) => setEditorState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                onClose={() => {
                    setEditingId(undefined);
                    setCreated(undefined);
                }}
                onChanged={() => {
                    const ticket = operation.capture();
                    if (operation.isCurrent(ticket)) refreshProject(ticket);
                }}
            />
        </section>
    );
    return (
        <WorkflowCharacterLibrary
            summary={assetSummary}
            episodeId={configurationEpisodeId || undefined}
            cast={projectCast}
            busy={libraryBlocked("character")}
            onChanged={() => refreshProject(operation.capture())}
            onDirtyChange={(dirty, busy) => reportLibraryState("character", dirty, busy)}
        >
            {renderAssets}
        </WorkflowCharacterLibrary>
    );
}

function WorkflowAssetColumn({
    summary,
    episodeId,
    kind,
    cast,
    busy,
    loading,
    selectable,
    extractionAction,
    headerActions,
    onChanged,
    onBusyChange,
    onAdd,
    onEdit,
    onGenerate,
    onDelete,
    onSaveToLibrary,
}: {
    summary: DramaSummary;
    episodeId?: string;
    kind: DramaCastKind;
    cast: DramaCast[];
    busy: boolean;
    loading: boolean;
    selectable: boolean;
    extractionAction?: ReactNode;
    headerActions?: ReactNode;
    onChanged: () => void;
    onBusyChange: (busy: boolean) => void;
    onAdd: () => void;
    onEdit: (cast: DramaCast) => void;
    onGenerate: (cast: DramaCast) => void;
    onDelete: (cast: DramaCast) => void;
    onSaveToLibrary?: (cast: DramaCast) => void;
}) {
    const [selection, setSelection] = useState<Set<string>>(() => new Set());
    const ids = cast.map((item) => item.id);
    const selected = ids.filter((id) => selection.has(id));
    const selectedCurrent = ids.filter((id) => selection.has(id));
    const allSelected = ids.length > 0 && selectedCurrent.length === ids.length;
    const base = cast.filter((item) => !item.parentId);
    const label = CAST_KIND_LABEL[kind];
    const Icon = kind === "character" ? UsersRound : kind === "scene" ? MapPinned : Gem;
    const toggle = (item: DramaCast, checked: boolean) => {
        if (busy) return;
        setSelection((previous) => {
            const next = new Set(previous);
            if (checked) next.add(item.id);
            else next.delete(item.id);
            return next;
        });
    };
    return (
        <section className="drama-workflow-assets-column" aria-label={`${label}资产`}>
            <header className="drama-workflow-assets-column-head">
                <h3>
                    <Icon className="size-4" aria-hidden />
                    {label}
                </h3>
                <div className="drama-workflow-assets-column-actions">
                    {extractionAction}
                    {selectable ? (
                        <WorkflowBatch
                            projectId={summary.project.id}
                            episodeId={episodeId}
                            revision={summary.production.revision}
                            targetIds={selected}
                            targetLabels={Object.fromEntries(cast.map((item) => [item.id, item.name]))}
                            actions={["cast_image"]}
                            compact
                            triggerLabel={`生成${label}图片`}
                            scopeDescription={`范围：当前集已选 ${selected.length} 项${label}及关联造型。`}
                            disabled={busy || loading}
                            onChanged={onChanged}
                            onBusyChange={onBusyChange}
                        />
                    ) : null}
                    {headerActions}
                    <Button size="small" type="text" icon={<Plus className="size-3.5" />} aria-label={`新增${label}`} disabled={busy} onClick={onAdd}>
                        新增
                    </Button>
                </div>
            </header>
            {selectable ? (
                <label className="drama-workflow-assets-column-count">
                    <input
                        type="checkbox"
                        aria-label={`选择本集全部${label}`}
                        checked={allSelected}
                        ref={(input) => {
                            if (input) input.indeterminate = selectedCurrent.length > 0 && !allSelected;
                        }}
                        disabled={busy || loading || !ids.length}
                        onChange={(event) => {
                            const checked = event.target.checked;
                            setSelection((previous) => {
                                const next = new Set(previous);
                                for (const id of ids) {
                                    if (checked) next.add(id);
                                    else next.delete(id);
                                }
                                return next;
                            });
                        }}
                    />
                    共 {base.length} 项{selected.length ? ` · 已选 ${selected.length} 项` : ""}
                </label>
            ) : null}
            <div className="drama-workflow-assets-column-content thin-scrollbar">
                {base.length ? (
                    <GuideAssets
                        compact
                        cast={cast}
                        busy={busy}
                        loading={loading}
                        onEdit={onEdit}
                        onGenerate={onGenerate}
                        onDelete={onDelete}
                        onSaveToLibrary={onSaveToLibrary}
                        selectedIds={selectable ? selection : undefined}
                        onSelect={selectable ? toggle : undefined}
                    />
                ) : (
                    <div className="drama-workflow-assets-column-empty" role="status">
                        <Icon className="size-7" aria-hidden />
                        <strong>{loading ? `正在读取${label}` : selectable ? `本集暂无关联${label}` : `暂无${label}资产`}</strong>
                        <p>{loading ? "请稍候" : selectable ? `可提取本集全部${label}，或新增资产。` : `可点击右上角新增${label}。`}</p>
                    </div>
                )}
            </div>
        </section>
    );
}
