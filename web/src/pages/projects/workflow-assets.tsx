import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, Select } from "antd";
import { ArrowRight, ChevronLeft, ChevronRight, Gem, MapPinned, Plus, UsersRound } from "lucide-react";

import { createDramaCast, getDramaEpisodeStyle, updateDramaEpisodeStyle, updateDramaWorkflowStyle, type DramaAssetSettings, type DramaCast, type DramaCastKind, type DramaSettings, type DramaSummary } from "@/services/api/drama";
import { dramaDrawingConfiguration } from "@/lib/drama/drawing-configuration";
import { useUserStore } from "@/stores/use-user-store";

import { AssetSchemePicker } from "./asset-scheme";
import { CAST_KIND_LABEL } from "./drama-shared";
import { GuideAssets } from "./guide-panels";
import { WorkflowAssetScope } from "./workflow-asset-scope";
import { WorkflowBatch } from "./workflow-batch";
import { WorkflowCharacterLibrary } from "./workflow-character-library";
import { CastEditorDialog } from "./studio/cast-editor-dialog";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { dramaKeys } from "./studio/use-studio";
import "./workflow-assets.css";

const KINDS = ["character", "scene", "prop"] as const satisfies readonly DramaCastKind[];

export type WorkflowAssetsProps = {
    variant?: "library" | "episode";
    episodeId?: string;
    onEpisodeChange?: (episodeId: string) => void;
    onPickChapters?: () => void;
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
type SchemeDraft = { value: DramaAssetSettings; baseline: string; revision: number; episodeId: string; episodeRevision: number };

function assetBaseline(settings: DramaAssetSettings) {
    return JSON.stringify(settings);
}

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
    onPickChapters,
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
    const assetEditBlocked = (summary.guide?.step || summary.production.guideStep) === "configuring";
    const operation = useDramaOperationScope(projectId);
    const [kind, setKind] = useState<DramaCastKind>("character");
    const [localEpisodeId, setLocalEpisodeId] = useState(() => summary.episodes.toSorted((left, right) => left.number - right.number)[0]?.id || "");
    const [addOpen, setAddOpen] = useState(false);
    const [addKind, setAddKind] = useState<DramaCastKind>("character");
    const [addDraft, setAddDraft] = useState<AddDraft>({ name: "" });
    const [created, setCreated] = useState<DramaCast>();
    const [revealShared, setRevealShared] = useState<{ episodeId: string; castId: string }>();
    const [editingId, setEditingId] = useState<string>();
    const [schemeOpen, setSchemeOpen] = useState(false);
    const [scheme, setScheme] = useState<SchemeDraft | null>(null);
    const [libraryState, setLibraryState] = useState({ dirty: false, busy: false });
    const [editorState, setEditorState] = useState({ dirty: false, busy: false });
    const [batchActivity, setBatchActivity] = useState<Partial<Record<DramaCastKind, boolean>>>({});
    const mutationLock = useRef(false);
    const latest = useRef({ onChanged, onGenerate, onDirtyChange, revision, frozen: busy, schemeStale: false });

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
    const episodeRevision = episodeConfiguration?.episodeRevision || 0;
    const episodeIndex = episodes.findIndex((episode) => episode.id === selectedEpisodeId);
    const schemeDirty = Boolean(scheme && assetBaseline(scheme.value) !== scheme.baseline);
    const schemeStale = Boolean(scheme && (scheme.revision !== revision || scheme.episodeId !== configurationEpisodeId || scheme.episodeRevision !== episodeRevision));
    useEffect(() => {
        const current = effectiveSettings.assets;
        setScheme((previous) => {
            if (!previous) return null;
            if (previous.episodeId !== configurationEpisodeId) return null;
            if (assetBaseline(previous.value) !== previous.baseline) return previous;
            if (previous.baseline === assetBaseline(current) && previous.revision === revision && previous.episodeRevision === episodeRevision) return previous;
            return { value: current, baseline: assetBaseline(current), revision, episodeId: configurationEpisodeId, episodeRevision };
        });
    }, [effectiveSettings.assets, revision, configurationEpisodeId, episodeRevision]);
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

    const create = useMutation({
        mutationFn: async (input: { kind: DramaCastKind; name: string; expectedRevision: number; episodeId: string; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            const name = input.name.trim();
            if (!name) throw new Error("请填写名称");
            if (name.length > 60) throw new Error("名称不能超过 60 字");
            return createDramaCast(input.ticket.projectId, { kind: input.kind, name, expectedRevision: input.expectedRevision });
        },
        onSuccess: ({ cast: createdCast }, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            setCreated(createdCast);
            if (input.episodeId) setRevealShared({ episodeId: input.episodeId, castId: createdCast.id });
            setEditingId(createdCast.id);
            setAddDraft({ name: "" });
            setAddOpen(false);
            refreshProject(input.ticket);
            message.success("已保存到作品共享资产，可继续编辑文字设定");
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            message.error(error instanceof Error ? error.message : "新增失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });

    const saveScheme = useMutation({
        mutationFn: async (input: { draft: SchemeDraft; settings: DramaSettings; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (input.draft.revision !== latest.current.revision) throw new Error("参考图方案已有更新，未保存。请重新载入或放弃修改。");
            if (variant === "episode") {
                if (!input.draft.episodeId) throw new Error("请先选择剧集并读取本集配置");
                return updateDramaEpisodeStyle(input.ticket.projectId, input.draft.episodeId, {
                    expectedRevision: input.draft.revision,
                    expectedEpisodeRevision: input.draft.episodeRevision,
                    settings: { ...input.settings, assets: input.draft.value },
                });
            }
            return updateDramaWorkflowStyle(input.ticket.projectId, {
                expectedRevision: input.draft.revision,
                styleName: input.settings.styleName,
                stylePrompt: input.settings.stylePrompt,
                drawing: dramaDrawingConfiguration({ ...input.settings, assets: input.draft.value }),
            });
        },
        onSuccess: (_result, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            setScheme(null);
            void queryClient.invalidateQueries({ queryKey: ["drama-episode-style", userId, input.ticket.projectId] });
            refreshProject(input.ticket);
            message.success("已保存后续参考图方案，不会覆盖已有图片");
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            message.error(error instanceof Error ? error.message : "保存失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });

    const pending = create.isPending || saveScheme.isPending;
    const batchBusy = KINDS.some((kind) => batchActivity[kind]);
    const frozen = locked || pending || libraryState.busy || editorState.busy || batchBusy;
    const assetFrozen = frozen || assetEditBlocked;
    latest.current = { onChanged, onGenerate, onDirtyChange, revision, frozen, schemeStale };
    const dirty = schemeDirty || Boolean(addDraft.name.trim()) || libraryState.dirty || editorState.dirty;
    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, pending || locked || libraryState.busy || editorState.busy || batchBusy);
    }, [dirty, pending, locked, libraryState.busy, editorState.busy, batchBusy]);
    useEffect(() => () => latest.current.onDirtyChange?.(false, false), []);

    const submitAdd = () => {
        if (assetFrozen || mutationLock.current) return;
        mutationLock.current = true;
        const expectedRevision = revision;
        const ticket = operation.capture();
        create.mutate({ kind: addKind, name: addDraft.name, expectedRevision, episodeId: variant === "episode" ? selectedEpisodeId : "", ticket });
    };

    const submitScheme = () => {
        if (!scheme || frozen || mutationLock.current || schemeStale) return;
        mutationLock.current = true;
        saveScheme.mutate({ draft: scheme, settings: effectiveSettings, ticket: operation.capture() });
    };

    const reloadScheme = () => {
        setScheme({ value: effectiveSettings.assets, baseline: assetBaseline(effectiveSettings.assets), revision, episodeId: configurationEpisodeId, episodeRevision });
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

    return (
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
                    {summary.production.reservedChapterCount > 0 ? (
                        <>
                            <span className="drama-workflow-assets-column-count" role="status" aria-atomic="true">
                                原文 {summary.production.chapterCount + summary.production.reservedChapterCount} 章 · 制作 {episodes.length} 集 · 待制作 {summary.production.reservedChapterCount} 章
                            </span>
                            {onPickChapters ? (
                                <Button size="small" disabled={frozen || dirty || Boolean(editingId)} onClick={onPickChapters}>
                                    继续选章
                                </Button>
                            ) : null}
                        </>
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
                            <button key={item} type="button" aria-pressed={kind === item} disabled={frozen && kind !== item} onClick={() => setKind(item)}>
                                {CAST_KIND_LABEL[item]}
                                <span>{counts[item]}</span>
                            </button>
                        ))}
                    </div>
                    <WorkflowCharacterLibrary
                        summary={summary}
                        cast={projectCast}
                        busy={locked || pending || assetEditBlocked}
                        onChanged={onChanged}
                        onDirtyChange={(dirty, busy) => setLibraryState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                    />
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
                <WorkflowAssetScope
                    key={variant}
                    summary={summary}
                    cast={projectCast}
                    kind={variant === "library" ? kind : undefined}
                    episodeId={variant === "episode" ? selectedEpisodeId : undefined}
                    showToolbar={variant === "library"}
                    sharedBeforeStoryboard={variant === "episode"}
                    busy={assetFrozen}
                    onChanged={onChanged}
                >
                    {(visible, refreshing, sharedCast) => (
                        <div className="drama-workflow-assets-columns">
                            {(variant === "library" ? [kind] : KINDS).map((columnKind) => (
                                <WorkflowAssetColumn
                                    key={`${selectedEpisodeId}:${columnKind}`}
                                    summary={assetSummary}
                                    episodeId={configurationEpisodeId || undefined}
                                    kind={columnKind}
                                    cast={visible.filter((item) => item.kind === columnKind)}
                                    sharedCast={sharedCast.filter((item) => item.kind === columnKind)}
                                    revealSharedId={revealShared?.episodeId === selectedEpisodeId ? revealShared.castId : undefined}
                                    busy={assetFrozen || refreshing}
                                    loading={loading}
                                    selectable={variant === "episode"}
                                    onBusyChange={(busy) => setBatchActivity((previous) => (previous[columnKind] === busy ? previous : { ...previous, [columnKind]: busy }))}
                                    onChanged={onChanged}
                                    onAdd={() => openAdd(columnKind)}
                                    onEdit={(item) => {
                                        if (!assetFrozen) setEditingId(item.id);
                                    }}
                                    onGenerate={(item) => {
                                        if (!assetFrozen) onGenerate(item, configurationEpisodeId || undefined);
                                    }}
                                />
                            ))}
                        </div>
                    )}
                </WorkflowAssetScope>
            </div>

            {variant === "episode" ? (
                <WorkflowCharacterLibrary
                    summary={assetSummary}
                    cast={projectCast}
                    busy={locked || pending || assetEditBlocked}
                    onChanged={onChanged}
                    onDirtyChange={(dirty, busy) => setLibraryState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                />
            ) : null}

            <details className="drama-workflow-assets-scheme" open={schemeOpen} onToggle={(event) => setSchemeOpen(event.currentTarget.open)}>
                <summary>后续参考图方案</summary>
                {schemeOpen ? (
                    <div className="drama-workflow-assets-scheme-body">
                        <p>这是{variant === "episode" ? "本集" : "本作品"}后续生成角色和场景参考图时使用的方案。道具模板固定。保存只影响以后的生成，不会覆盖已有图片，也不会重新生成或改写已有资产提示词。</p>
                        {schemeStale && schemeDirty ? (
                            <div role="alert">
                                <p>参考图方案已有更新，当前修改已保留，暂时不能保存。</p>
                                <div className="drama-workflow-assets-actions">
                                    <Button disabled={frozen} onClick={reloadScheme}>
                                        重新载入
                                    </Button>
                                    <Button disabled={frozen} onClick={() => setScheme(null)}>
                                        放弃修改
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                        {frozen || (schemeStale && schemeDirty) ? (
                            <div className="drama-workflow-assets-scheme-preview" aria-label="参考图方案只读预览">
                                <p>
                                    当前方案：{effectiveSettings.assets.mode} · 角色画幅 {effectiveSettings.assets.characterRatio}
                                    {schemeDirty ? "（本地修改未保存）" : ""}
                                </p>
                            </div>
                        ) : (
                            <fieldset disabled={frozen}>
                                <legend className="sr-only">编辑后续参考图方案</legend>
                                <AssetSchemePicker
                                    layout="compact"
                                    value={scheme?.value || effectiveSettings.assets}
                                    onChange={(value) => {
                                        if (latest.current.frozen || latest.current.schemeStale || latest.current.revision !== revision) return;
                                        setScheme((previous) => {
                                            const baseline = previous?.baseline || assetBaseline(effectiveSettings.assets);
                                            const captured = previous?.revision || revision;
                                            return { value, baseline, revision: captured, episodeId: configurationEpisodeId, episodeRevision: previous?.episodeRevision || episodeRevision };
                                        });
                                    }}
                                />
                            </fieldset>
                        )}
                        {!(schemeStale && schemeDirty) ? (
                            <div className="drama-workflow-assets-actions">
                                {schemeDirty ? (
                                    <Button disabled={frozen} onClick={() => setScheme(null)}>
                                        放弃修改
                                    </Button>
                                ) : null}
                                <Button type="primary" disabled={frozen || !schemeDirty || schemeStale} loading={saveScheme.isPending} onClick={submitScheme}>
                                    保存后续参考图方案
                                </Button>
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <p>展开后选择{variant === "episode" ? "本集" : "本作品"}后续参考图方案。道具模板固定，保存不会改写已有资产。</p>
                )}
            </details>

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
}

function WorkflowAssetColumn({
    summary,
    episodeId,
    kind,
    cast,
    sharedCast,
    revealSharedId,
    busy,
    loading,
    selectable,
    onChanged,
    onBusyChange,
    onAdd,
    onEdit,
    onGenerate,
}: {
    summary: DramaSummary;
    episodeId?: string;
    kind: DramaCastKind;
    cast: DramaCast[];
    sharedCast: DramaCast[];
    revealSharedId?: string;
    busy: boolean;
    loading: boolean;
    selectable: boolean;
    onChanged: () => void;
    onBusyChange: (busy: boolean) => void;
    onAdd: () => void;
    onEdit: (cast: DramaCast) => void;
    onGenerate: (cast: DramaCast) => void;
}) {
    const [selection, setSelection] = useState<Set<string>>(() => new Set());
    const [sharedOpen, setSharedOpen] = useState(false);
    const shouldRevealShared = Boolean(revealSharedId && sharedCast.some((item) => item.id === revealSharedId));
    useEffect(() => {
        if (shouldRevealShared) setSharedOpen(true);
    }, [revealSharedId, shouldRevealShared]);
    const ids = cast.map((item) => item.id);
    const selected = [...ids, ...sharedCast.map((item) => item.id)].filter((id) => selection.has(id));
    const selectedCurrent = ids.filter((id) => selection.has(id));
    const allSelected = ids.length > 0 && selectedCurrent.length === ids.length;
    const base = cast.filter((item) => !item.parentId);
    const sharedBase = sharedCast.filter((item) => !item.parentId);
    const sharedBaseIds = new Set(sharedBase.map((item) => item.id));
    const sharedGroupCast = sharedCast.filter((item) => !item.parentId || sharedBaseIds.has(item.parentId));
    const sharedLooks = sharedCast.filter((item) => item.parentId && cast.some((parent) => parent.id === item.parentId));
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
                    {selectable ? (
                        <WorkflowBatch
                            projectId={summary.project.id}
                            episodeId={episodeId}
                            revision={summary.production.revision}
                            targetIds={selected}
                            targetLabels={Object.fromEntries([...cast, ...sharedCast].map((item) => [item.id, item.name]))}
                            actions={["cast_image"]}
                            compact
                            triggerLabel={`生成${label}图片`}
                            scopeDescription={`范围：当前列表已选 ${selected.length} 项${label}及造型，包含已勾选的作品共享主体。`}
                            disabled={busy || loading}
                            onChanged={onChanged}
                            onBusyChange={onBusyChange}
                        />
                    ) : null}
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
            {base.length ? (
                <GuideAssets
                    cast={[...cast, ...sharedLooks]}
                    sharedLookIds={new Set(sharedLooks.map((item) => item.id))}
                    busy={busy}
                    loading={loading}
                    onEdit={onEdit}
                    onGenerate={onGenerate}
                    selectedIds={selectable ? selection : undefined}
                    onSelect={selectable ? toggle : undefined}
                />
            ) : (
                <div className="drama-workflow-assets-column-empty" role="status">
                    <Icon className="size-7" aria-hidden />
                    <strong>{loading ? `正在读取${label}` : sharedBase.length ? `本集暂无引用${label}` : `暂无${label}资产`}</strong>
                    <p>{loading ? "请稍候" : sharedBase.length ? "可展开下方作品共享主体，或点击右上角新增。" : `可点击右上角新增${label}。`}</p>
                </div>
            )}
            {sharedBase.length ? (
                <details className="drama-workflow-assets-shared" open={sharedOpen} onToggle={(event) => setSharedOpen(event.currentTarget.open)}>
                    <summary>作品共享 · 本集未引用（{sharedBase.length}）</summary>
                    <p>这些主体已保存在作品中，可继续编辑、勾选或生成；引用到镜头后会显示在本集列表。</p>
                    {sharedOpen ? <GuideAssets cast={sharedGroupCast} busy={busy} loading={loading} onEdit={onEdit} onGenerate={onGenerate} selectedIds={selectable ? selection : undefined} onSelect={selectable ? toggle : undefined} /> : null}
                </details>
            ) : null}
        </section>
    );
}
