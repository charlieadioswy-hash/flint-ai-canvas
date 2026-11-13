import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { Plus, RefreshCw } from "lucide-react";

import { ApiError } from "@/services/api/request";
import { createDramaCast, extractDramaCast, listDramaChapters, updateDramaSettings, type DramaAssetSettings, type DramaCast, type DramaCastKind, type DramaSettings, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { AssetSchemePicker } from "./asset-scheme";
import { CAST_KIND_LABEL } from "./drama-shared";
import { GuideAssets } from "./guide-panels";
import { CastEditorDialog } from "./studio/cast-editor-dialog";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { dramaKeys } from "./studio/use-studio";
import "./workflow-assets.css";

const KINDS = ["character", "scene", "prop"] as const satisfies readonly DramaCastKind[];

export type WorkflowAssetsProps = {
    summary: DramaSummary;
    cast: DramaCast[];
    loading?: boolean;
    busy?: boolean;
    error?: unknown;
    onRetry?: () => void;
    onChanged: () => void;
    onGenerate: (cast: DramaCast) => void;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
};

type ExtractRange = "current" | "episodes";
type AddDraft = { name: string };
type SchemeDraft = { value: DramaAssetSettings; baseline: string; revision: number };

function staleConflict(error: unknown) {
    return error instanceof ApiError && (error.reason === "conflict" || error.status === 409);
}

function assetBaseline(settings: DramaAssetSettings) {
    return JSON.stringify(settings);
}

function belongsToProject(item: DramaCast, projectId: string) {
    return item.projectId === projectId;
}

export function WorkflowAssets(props: WorkflowAssetsProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <WorkflowAssetsSession key={`${userId}:${props.summary.project.id}`} {...props} userId={userId} />;
}

function WorkflowAssetsSession({ summary, cast, loading = false, busy = false, error, onRetry, onChanged, onGenerate, onDirtyChange, userId }: WorkflowAssetsProps & { userId: string }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const projectId = summary.project.id;
    const revision = summary.production.revision;
    const operation = useDramaOperationScope(projectId);
    const [kind, setKind] = useState<DramaCastKind>("character");
    const [range, setRange] = useState<ExtractRange>("current");
    const [episodeIds, setEpisodeIds] = useState<string[]>([]);
    const [addOpen, setAddOpen] = useState(false);
    const [addDraft, setAddDraft] = useState<AddDraft>({ name: "" });
    const [created, setCreated] = useState<DramaCast>();
    const [editingId, setEditingId] = useState<string>();
    const [schemeOpen, setSchemeOpen] = useState(false);
    const [scheme, setScheme] = useState<SchemeDraft | null>(null);
    const mutationLock = useRef(false);
    const latest = useRef({ onChanged, onGenerate, onDirtyChange, revision, frozen: busy, schemeStale: false });

    const chapters = useQuery({
        queryKey: [...dramaKeys.chapters(projectId), userId],
        queryFn: ({ signal }) => listDramaChapters(projectId, signal),
    });

    useEffect(() => {
        const current = summary.production.settings.assets;
        setScheme((previous) => {
            if (!previous) return null;
            if (assetBaseline(previous.value) !== previous.baseline) return previous;
            if (previous.baseline === assetBaseline(current) && previous.revision === revision) return previous;
            return { value: current, baseline: assetBaseline(current), revision };
        });
    }, [summary.production.settings.assets, revision]);

    const projectCast = cast.filter((item) => belongsToProject(item, projectId));
    const visible = projectCast.filter((item) => item.kind === kind);
    const counts = Object.fromEntries(KINDS.map((item) => [item, projectCast.filter((entry) => entry.kind === item && !entry.parentId).length])) as Record<DramaCastKind, number>;
    const episodes = summary.episodes.filter((episode) => episode.id);
    const selectedEpisodes = episodeIds.filter((id) => episodes.some((episode) => episode.id === id));
    const selectedChapters = (chapters.data?.chapters || []).filter((chapter) => !chapter.reserved);
    const schemeDirty = Boolean(scheme && assetBaseline(scheme.value) !== scheme.baseline);
    const schemeStale = Boolean(scheme && scheme.revision !== revision);
    useEffect(() => {
        if (created && cast.some((item) => item.id === created.id && item.projectId === projectId)) setCreated(undefined);
    }, [cast, created, projectId]);
    const editorCast = created && created.projectId === projectId && !projectCast.some((item) => item.id === created.id) ? [...projectCast, created] : projectCast;
    const locked = busy;

    const refreshProject = (ticket: ReturnType<typeof operation.capture>) => {
        if (!operation.isCurrent(ticket)) return;
        void queryClient.invalidateQueries({ queryKey: dramaKeys.summary(ticket.projectId) });
        void queryClient.invalidateQueries({ queryKey: dramaKeys.cast(ticket.projectId) });
        void queryClient.invalidateQueries({ queryKey: dramaKeys.chapters(ticket.projectId) });
        latest.current.onChanged();
    };

    const extract = useMutation({
        mutationFn: async (input: { kind: DramaCastKind; range: ExtractRange; episodeIds: string[]; expectedRevision: number; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (input.expectedRevision !== latest.current.revision) throw new Error("资产范围已有更新，未开始提取。请重新载入后再试。");
            if (input.range === "episodes" && !input.episodeIds.length) throw new Error("请至少选择一集后再提取");
            return extractDramaCast(input.ticket.projectId, {
                expectedRevision: input.expectedRevision,
                kind: input.kind,
                ...(input.range === "episodes" ? { episodeIds: input.episodeIds } : {}),
            });
        },
        onSuccess: (_result, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            refreshProject(input.ticket);
            message.success(`已排队提取遗漏的${CAST_KIND_LABEL[input.kind]}，保留已有设定`);
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            message.error(staleConflict(error) ? "资产范围已有更新，未开始提取。请重新载入后再试。" : error instanceof Error ? error.message : "提取失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });

    const create = useMutation({
        mutationFn: async (input: { kind: DramaCastKind; name: string; expectedRevision: number; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            const name = input.name.trim();
            if (!name) throw new Error("请填写名称");
            if (name.length > 60) throw new Error("名称不能超过 60 字");
            return createDramaCast(input.ticket.projectId, { kind: input.kind, name, expectedRevision: input.expectedRevision });
        },
        onSuccess: ({ cast: createdCast }, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            setCreated(createdCast);
            setEditingId(createdCast.id);
            setAddDraft({ name: "" });
            setAddOpen(false);
            refreshProject(input.ticket);
            message.success("已新增资产，可继续编辑文字设定");
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            message.error(staleConflict(error) ? "作品已有更新，未新增。请重新载入后再试。" : error instanceof Error ? error.message : "新增失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });

    const saveScheme = useMutation({
        mutationFn: async (input: { draft: SchemeDraft; settings: DramaSettings; ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(input.ticket)) throw new Error("作品或登录状态已变化，请重新操作");
            if (input.draft.revision !== latest.current.revision) throw new Error("参考图方案已有更新，未保存。请重新载入或放弃修改。");
            return updateDramaSettings(input.ticket.projectId, {
                expectedRevision: input.draft.revision,
                settings: { ...input.settings, assets: input.draft.value },
            });
        },
        onSuccess: (_result, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            setScheme(null);
            refreshProject(input.ticket);
            message.success("已保存后续参考图方案，不会覆盖已有图片");
        },
        onError: (error, input) => {
            if (!operation.isCurrent(input.ticket)) return;
            message.error(staleConflict(error) ? "参考图方案已有更新，未保存。请重新载入或放弃修改。" : error instanceof Error ? error.message : "保存失败");
        },
        onSettled: () => {
            mutationLock.current = false;
        },
    });

    const pending = extract.isPending || create.isPending || saveScheme.isPending;
    const frozen = locked || pending;
    latest.current = { onChanged, onGenerate, onDirtyChange, revision, frozen, schemeStale };
    const rangeStale = extract.isError && (staleConflict(extract.error) || extract.variables?.expectedRevision !== revision);
    const dirty = schemeDirty || Boolean(addDraft.name.trim());
    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, pending || busy);
    }, [dirty, pending, busy]);
    useEffect(() => () => latest.current.onDirtyChange?.(false, false), []);

    const startExtract = () => {
        if (frozen || mutationLock.current) return;
        if (range === "episodes" && !selectedEpisodes.length) {
            message.error("请至少选择一集后再提取");
            return;
        }
        mutationLock.current = true;
        const expectedRevision = revision;
        const ticket = operation.capture();
        extract.mutate({ kind, range, episodeIds: selectedEpisodes, expectedRevision, ticket });
    };

    const submitAdd = () => {
        if (frozen || mutationLock.current) return;
        mutationLock.current = true;
        const expectedRevision = revision;
        const ticket = operation.capture();
        create.mutate({ kind, name: addDraft.name, expectedRevision, ticket });
    };

    const submitScheme = () => {
        if (!scheme || frozen || mutationLock.current || schemeStale) return;
        mutationLock.current = true;
        saveScheme.mutate({ draft: scheme, settings: summary.production.settings, ticket: operation.capture() });
    };

    const reloadScheme = () => {
        setScheme({ value: summary.production.settings.assets, baseline: assetBaseline(summary.production.settings.assets), revision });
    };

    return (
        <section className="drama-workflow-assets" aria-label="主体资产">
            <header className="drama-workflow-assets-head">
                <div>
                    <h2>主体资产</h2>
                    <p>审阅文字设定，按需生成参考图；图片也可以稍后再生成。</p>
                </div>
                <Button icon={<Plus className="size-3.5" />} disabled={frozen} onClick={() => setAddOpen(true)}>
                    快速新增
                </Button>
            </header>

            <div className="drama-workflow-assets-tabs" role="tablist" aria-label="资产类型">
                {KINDS.map((item) => (
                    <button key={item} type="button" role="tab" aria-selected={kind === item} disabled={frozen && kind !== item} onClick={() => setKind(item)}>
                        {CAST_KIND_LABEL[item]}
                        <span>{counts[item]}</span>
                    </button>
                ))}
            </div>

            <form
                className="drama-workflow-assets-extract"
                aria-label={`增量提取${CAST_KIND_LABEL[kind]}`}
                onSubmit={(event) => {
                    event.preventDefault();
                    startExtract();
                }}
            >
                <fieldset disabled={frozen}>
                    <legend>增量提取{CAST_KIND_LABEL[kind]}文字</legend>
                    <p>仅新增正文中遗漏的资产，保留已有设定和图片。</p>
                    <div className="drama-workflow-assets-range" role="radiogroup" aria-label="提取范围">
                        <label>
                            <input type="radio" name="extract-range" value="current" checked={range === "current"} onChange={() => setRange("current")} />
                            当前制作章节
                            <small>{chapters.isLoading ? "正在读取章节" : chapters.isError ? "章节读取失败" : selectedChapters.length ? `使用已加入制作的 ${selectedChapters.length} 章` : "当前没有已加入制作的章节"}</small>
                        </label>
                        <label>
                            <input type="radio" name="extract-range" value="episodes" checked={range === "episodes"} onChange={() => setRange("episodes")} />
                            指定集
                            <small>只使用本作品的集，必须至少选一集</small>
                        </label>
                    </div>
                    {range === "episodes" ? (
                        episodes.length ? (
                            <div className="drama-workflow-assets-episodes" role="group" aria-label="选择要提取的集">
                                {episodes.map((episode) => (
                                    <label key={episode.id}>
                                        <input
                                            type="checkbox"
                                            aria-label={`提取 ${episode.title || `第 ${episode.number} 集`}`}
                                            checked={selectedEpisodes.includes(episode.id)}
                                            onChange={(event) => setEpisodeIds(event.target.checked ? [...selectedEpisodes, episode.id] : selectedEpisodes.filter((id) => id !== episode.id))}
                                        />
                                        {episode.title || `第 ${episode.number} 集`}
                                    </label>
                                ))}
                            </div>
                        ) : (
                            <p role="status">本作品还没有可选择的集。</p>
                        )
                    ) : null}
                    {chapters.isError && range === "current" ? (
                        <p role="alert">
                            当前制作章节暂时无法读取。
                            <Button size="small" onClick={() => void chapters.refetch()}>
                                重试
                            </Button>
                        </p>
                    ) : null}
                    {rangeStale ? (
                        <p role="alert">
                            提取时的版本已过期，范围仍保留。请刷新作品后再重试。
                            <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => latest.current.onChanged()}>
                                刷新后重试
                            </Button>
                        </p>
                    ) : null}
                    {busy ? <p role="status">当前操作进行中，请完成后再提取或修改。</p> : null}
                    <Button htmlType="submit" type="primary" loading={extract.isPending} disabled={frozen || (range === "current" && (chapters.isLoading || chapters.isError || !selectedChapters.length))}>
                        提取{CAST_KIND_LABEL[kind]}文字
                    </Button>
                </fieldset>
            </form>

            {addOpen ? (
                <form
                    className="drama-workflow-assets-add"
                    aria-label={`快速新增${CAST_KIND_LABEL[kind]}`}
                    onSubmit={(event) => {
                        event.preventDefault();
                        submitAdd();
                    }}
                >
                    <fieldset disabled={frozen}>
                        <legend>快速新增{CAST_KIND_LABEL[kind]}</legend>
                        <p>先保存名称，再补充文字设定。这里不会猜测描述或开始生成图片。</p>
                        <label>
                            名称
                            <Input aria-label="资产名称" maxLength={60} value={addDraft.name} onChange={(event) => setAddDraft((current) => ({ ...current, name: event.target.value }))} />
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
                            <Button htmlType="submit" type="primary" loading={create.isPending} disabled={frozen || !addDraft.name.trim()}>
                                保存资产
                            </Button>
                        </div>
                    </fieldset>
                </form>
            ) : null}

            <div role="tabpanel" aria-label={`${CAST_KIND_LABEL[kind]}列表`}>
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
                {counts[kind] ? (
                    <GuideAssets
                        cast={visible}
                        busy={frozen}
                        loading={loading}
                        onEdit={(item) => {
                            if (!frozen) setEditingId(item.id);
                        }}
                        onGenerate={(item) => {
                            if (!frozen) onGenerate(item);
                        }}
                    />
                ) : !loading && !error ? (
                    <p className="drama-workflow-assets-status" role="status">
                        暂无{CAST_KIND_LABEL[kind]}，可按正文增量提取，或输入名称新增。
                    </p>
                ) : null}
            </div>

            <details className="drama-workflow-assets-scheme" open={schemeOpen} onToggle={(event) => setSchemeOpen(event.currentTarget.open)}>
                <summary>后续参考图方案</summary>
                {schemeOpen ? (
                    <div className="drama-workflow-assets-scheme-body">
                        <p>这是本作品后续生成角色和场景参考图时使用的方案。道具模板固定。保存只影响以后的生成，不会覆盖已有图片，也不会重新生成或改写已有资产提示词。</p>
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
                                    当前方案：{summary.production.settings.assets.mode} · 角色画幅 {summary.production.settings.assets.characterRatio}
                                    {schemeDirty ? "（本地修改未保存）" : ""}
                                </p>
                            </div>
                        ) : (
                            <fieldset disabled={frozen}>
                                <legend className="sr-only">编辑后续参考图方案</legend>
                                <AssetSchemePicker
                                    layout="compact"
                                    value={scheme?.value || summary.production.settings.assets}
                                    onChange={(value) => {
                                        if (latest.current.frozen || latest.current.schemeStale || latest.current.revision !== revision) return;
                                        setScheme((previous) => {
                                            const baseline = previous?.baseline || assetBaseline(summary.production.settings.assets);
                                            const captured = previous?.revision || revision;
                                            return { value, baseline, revision: captured };
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
                    <p>展开后选择本作品后续参考图方案。道具模板固定，保存不会改写已有资产。</p>
                )}
            </details>

            <CastEditorDialog
                summary={summary}
                cast={editorCast}
                castId={editingId}
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
