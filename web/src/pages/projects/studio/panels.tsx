import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Checkbox, Input, InputNumber, Select, Switch } from "antd";
import {
    AlertCircle,
    ArrowRight,
    Brush,
    CheckCheck,
    Clapperboard,
    Film,
    FolderOpen,
    Gem,
    Inbox,
    Lock,
    MapPinned,
    Maximize2,
    PauseCircle,
    RefreshCw,
    RotateCcw,
    ScrollText,
    Upload,
    UserRound,
    UsersRound,
    Cpu,
    PackageCheck,
    Play,
    Plus,
    Link2,
    Shirt,
    Trash2,
} from "lucide-react";

import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { ApiError } from "@/services/api/request";
import { dramaChoiceKey, dramaResolutionAfterModelChange, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import { formatVideoResolutionLabel } from "@/lib/video-generation-options";
import { useUserStore } from "@/stores/use-user-store";
import {
    regenerateDramaCast,
    getDrama,
    listDramaCast,
    regenerateDramaCasts,
    setDramaCastImage,
    updateDramaCast,
    updateDramaCastLook,
    deleteDramaCastLook,
    updateDramaSettings,
    type DramaCapability,
    type DramaCast,
    type DramaCastPatch,
    type DramaCastKind,
    type DramaEpisodeMode,
    type DramaSettings,
    type DramaInboxItem,
    type DramaMediaMode,
    type DramaModelChoice,
    type DramaReviewMode,
    type DramaSummary,
    type DramaTextThinking,
    type DramaVideoContinuity,
} from "@/services/api/drama";

import { aspectRatioValue, CAST_KIND_LABEL, EpisodeGroupField, formatCredits, MEDIA_MODE_LABEL, mediaBusy, MediaThumb, parseList, VIDEO_CONTINUITY_LABEL } from "../drama-shared";
import { AssetSchemePicker } from "../asset-scheme";
import { DramaModelPicker, useDramaModelCatalog } from "../drama-model-picker";
import { DramaAssetImageModels, DramaTextSteps, VideoResolutionField } from "../step-settings";
import { StoryboardRules } from "../storyboard-rules";
import { progressFillStyle } from "@/lib/progress-fill";
import { uploadResourceFile } from "@/services/api/resources";
import { DramaTakeList } from "./take-list";
import { CastLibraryPicker } from "./cast-library-picker";
import { CastVoiceField, CastVoicePreview } from "./cast-voice";
import { CastImageOptions, castImageOptionsDraft } from "./cast-image-options";
import { CastViews, CastViewWorkspace } from "./cast-views";
import { CastLooks } from "./cast-looks";
import { useCastRegenerationGuard } from "./use-cast-regeneration-guard";
import { CastImageFields, type CastImageFieldsValue } from "./cast-image-fields";
import { CastCreateDialog } from "./cast-create-dialog";
import { CastProjectImport } from "./cast-project-import";
import "./cast-editor-workspace.css";

// 制作台的三个整页视图：设定（角色 / 道具 / 场景）、待处理、制作设置。都在主区域内展示，不使用抽屉遮挡。

// ===== 设定 =====

const CAST_KIND_ICON: Record<DramaCastKind, ReactNode> = { character: <UserRound className="size-6 opacity-30" />, prop: <Gem className="size-6 opacity-30" />, scene: <MapPinned className="size-6 opacity-30" /> };
const CAST_KINDS: DramaCastKind[] = ["character", "prop", "scene"];
const CAST_TABS = ["character", "look", "prop", "scene"] as const;
type CastTab = (typeof CAST_TABS)[number];

type CastFilter = "all" | "failed" | "busy" | "locked";

/** 资产参考图统一横版 16:9；角色按参考图方案的画幅（内置方案均为 16:9）。图片完整显示不裁切，占位与成图同尺寸。 */
const ASSET_IMAGE_RATIO = "16:9";

function castRatio(kind: DramaCastKind, ratios: CastRatios) {
    const ratio = (kind === "character" && ratios.character) || ASSET_IMAGE_RATIO;
    const [width, height] = ratio.split(":").map(Number);
    const orientation = width && height ? (width > height ? "is-wide" : width < height ? "is-tall" : "is-square") : "is-tall";
    return { style: { "--drama-cast-ratio": aspectRatioValue(ratio) } as CSSProperties, orientation };
}

export type CastRatios = { character: string };

/** 媒体轮询不重置输入，切换设定或服务端表单内容变化时重新回填。 */
function castEditorFormKey(cast: DramaCast) {
    return JSON.stringify([
        cast.id,
        cast.name,
        cast.lookName,
        cast.appearance,
        cast.aliasesJson,
        cast.voiceInstructions,
        cast.imagePrompt,
        cast.imageStyleId,
        cast.imageStyleName,
        cast.imageStylePrompt,
        cast.lookFromChapter,
        cast.lookToChapter,
        cast.imageOptionsJson || "",
    ]);
}

const castImageLoading = <span className="drama-cast-media-state is-loading" role="status" aria-label="参考图加载中" />;
const castImageFailed = (
    <span className="drama-cast-media-state">
        <AlertCircle className="size-3.5" />
        图片加载失败
    </span>
);

export function CastPanel({
    projectId,
    cast,
    ratios,
    focusId,
    retrying,
    assetsPending,
    releasing,
    onFocus,
    onRetry,
    onChanged,
    onReleaseAssets,
    onOpenCanvas,
    canvasOpening,
}: {
    projectId: string;
    cast: DramaCast[];
    ratios: CastRatios;
    focusId: string;
    retrying: boolean;
    assetsPending: boolean;
    releasing: boolean;
    onFocus: (id: string) => void;
    onRetry: () => void;
    onChanged: () => void;
    onReleaseAssets: () => void;
    /** 把设定投送到精修画布（已投送则定位）。 */
    onOpenCanvas: (castId: string) => void;
    /** 正在打开画布的设定 ID。 */
    canvasOpening?: string;
}) {
    const [kind, setKind] = useState<CastTab>("character");
    const [filter, setFilter] = useState<CastFilter>("all");
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    const focused = cast.find((item) => item.id === focusId);
    const focusedKind = focused?.kind;
    const focusedParent = focused?.parentId;
    useEffect(() => {
        if (focusedKind) setKind((current) => (focusedParent ? (current === "character" ? current : "look") : focusedKind));
    }, [focusId, focusedKind, focusedParent]);
    const bases = cast.filter((item) => !item.parentId);
    const ofKind = kind === "look" ? cast.filter((item) => item.parentId) : bases.filter((item) => item.kind === kind);
    const failed = cast.filter((item) => item.imageStatus === "failed").length;
    const count = (predicate: (item: DramaCast) => boolean) => ofKind.filter(predicate).length;
    const filters: Array<[CastFilter, string, number]> = [
        ["all", "全部", ofKind.length],
        ["failed", "失败", count((item) => item.imageStatus === "failed")],
        ["busy", "生成中", count((item) => mediaBusy(item.imageStatus))],
        ["locked", "已锁定", count((item) => item.locked)],
    ];
    const list = ofKind.filter((item) => {
        if (filter === "failed") return item.imageStatus === "failed";
        if (filter === "busy") return mediaBusy(item.imageStatus);
        if (filter === "locked") return item.locked;
        return true;
    });
    const active = focused && (kind === "look" ? focused.parentId : focused.kind === kind) ? focused : list[0];
    const kindRatio = castRatio(kind === "look" ? "character" : kind, ratios);
    const tabLabel = (value: CastTab) => (value === "look" ? "造型" : CAST_KIND_LABEL[value]);
    return (
        <div className="drama-view drama-cast-layout">
            <section className="drama-view-main">
                <div className="drama-view-head">
                    <div className="drama-tabs" role="tablist" aria-label="设定类型">
                        {CAST_TABS.map((value) => (
                            <button
                                key={value}
                                type="button"
                                role="tab"
                                className="drama-tab"
                                aria-selected={kind === value}
                                onClick={() => {
                                    setKind(value);
                                    setFilter("all");
                                }}
                            >
                                {tabLabel(value)}
                                <span className="drama-tab-count">{value === "look" ? cast.filter((item) => item.parentId).length : bases.filter((item) => item.kind === value).length}</span>
                            </button>
                        ))}
                    </div>
                    <div className="drama-filters" role="group" aria-label="筛选">
                        {filters.map(([key, label, value]) => (
                            <button key={key} type="button" className={`drama-filter ${key === "failed" && value ? "is-alert" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                                {label}
                                <b>{value}</b>
                            </button>
                        ))}
                    </div>
                    <div className="drama-cast-toolbar">
                        <Button icon={<Link2 className="size-4" />} onClick={() => setImporting(true)}>
                            关联已有作品素材
                        </Button>
                        <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                            新增设定
                        </Button>
                    </div>
                    {failed ? (
                        <Button className="!ml-auto" icon={<RotateCcw className="size-4" />} loading={retrying} onClick={onRetry}>
                            重试失败的 {failed} 个
                        </Button>
                    ) : null}
                </div>
                <div className="drama-view-scroll thin-scrollbar">
                    {assetsPending && cast.some((item) => item.imageStatus === "") ? (
                        <div className="drama-banner is-ready is-flush">
                            <Clapperboard className="size-5 shrink-0 text-[var(--workspace-accent)]" />
                            <div className="drama-banner-text">
                                <strong>参考图还没有生成</strong>
                                <span>先核对角色、道具与场景的名称和外观描述，满意后再生成参考图；也可以在右侧单独生成某一个。参考图会随剧情段视频请求一起发送，保持人物和道具一致。</span>
                            </div>
                            <Button type="primary" icon={<Play className="size-4" />} loading={releasing} onClick={onReleaseAssets}>
                                生成全部参考图
                            </Button>
                        </div>
                    ) : null}
                    <div className={`drama-cast-grid ${kindRatio.orientation}`}>
                        {list.map((item) => (
                            <div key={item.id} className="drama-cast-card" aria-current={item.id === active?.id || item.id === active?.parentId}>
                                <button type="button" className="block w-full text-left" aria-label={`编辑${item.lookName || item.name}`} onClick={() => onFocus(item.id)}>
                                    <div className="drama-cast-card-media" style={kindRatio.style}>
                                        {item.imageResourceId ? <MediaThumb resourceId={item.imageResourceId} alt={item.name} loading={castImageLoading} failed={castImageFailed} /> : null}
                                        {!item.imageResourceId || mediaBusy(item.imageStatus) || item.imageStatus === "failed" || item.imageStatus === "" ? (
                                            <div className={`drama-shot-placeholder ${mediaBusy(item.imageStatus) ? "is-busy" : ""}`}>
                                                {item.imageStatus === "failed" ? (
                                                    <span className="drama-cast-card-failed">
                                                        <AlertCircle className="size-3.5" />
                                                        生成失败
                                                    </span>
                                                ) : item.imageResourceId ? (
                                                    "更新中…"
                                                ) : (
                                                    CAST_KIND_ICON[item.kind]
                                                )}
                                            </div>
                                        ) : null}
                                        {item.locked ? (
                                            <span className="drama-shot-flags">
                                                <span className="drama-flag is-lock">
                                                    <Lock className="size-3" />
                                                </span>
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="drama-cast-card-body">
                                        <strong>{item.lookName || item.name}</strong>
                                        <span>
                                            {item.parentId
                                                ? `${cast.find((base) => base.id === item.parentId)?.name || item.name} · ${item.imageStyleName || "沿用作品风格"}`
                                                : item.role || parseList(item.aliasesJson).join("、") || item.description || "—"}
                                        </span>
                                    </div>
                                </button>
                                {item.kind === "character" && !item.parentId && cast.some((look) => look.parentId === item.id) ? (
                                    <div className="drama-cast-look-switcher" role="group" aria-label={`${item.name}的造型`}>
                                        {[item, ...cast.filter((look) => look.parentId === item.id)].map((look) => (
                                            <button type="button" key={look.id} aria-label={`切换到${look.lookName || "基础造型"}`} title={look.lookName || "基础造型"} aria-pressed={look.id === active?.id} onClick={() => onFocus(look.id)}>
                                                {look.imageResourceId ? <MediaThumb resourceId={look.imageResourceId} alt={look.lookName || "基础造型"} /> : <Shirt className="size-4 opacity-40" />}
                                            </button>
                                        ))}
                                    </div>
                                ) : null}
                                {item.kind === "character" && !item.parentId ? (
                                    <div className="px-2 pb-2">
                                        <CastVoicePreview resourceId={item.voiceSampleResourceId} name={item.name} />
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                    {!list.length ? (
                        <div className="drama-empty">
                            <UserRound className="size-7" />
                            <span>{ofKind.length ? "没有符合筛选的设定" : kind === "look" ? "选择角色后可添加造型，或从已有作品关联素材" : `可新增${CAST_KIND_LABEL[kind]}，也可从已有作品关联素材`}</span>
                        </div>
                    ) : null}
                </div>
            </section>
            <aside className="drama-view-side thin-scrollbar">
                {active ? (
                    <CastEditor
                        key={active.id}
                        projectId={projectId}
                        cast={active}
                        parent={active.parentId ? cast.find((item) => item.id === active.parentId) : undefined}
                        looks={cast.filter((item) => item.parentId === active.id)}
                        ratios={ratios}
                        onChanged={onChanged}
                        onOpenCanvas={() => onOpenCanvas(active.id)}
                        canvasOpening={canvasOpening === active.id}
                    />
                ) : (
                    <div className="drama-empty is-compact">
                        <span>选择一个设定查看详情</span>
                    </div>
                )}
            </aside>
            {creating ? (
                <CastCreateDialog
                    projectId={projectId}
                    initialKind={kind === "look" ? "character" : kind}
                    onClose={() => setCreating(false)}
                    onCreated={(item) => {
                        setKind(item.kind);
                        onFocus(item.id);
                        onChanged();
                    }}
                />
            ) : null}
            {importing ? <CastProjectImport projectId={projectId} currentCast={cast} onClose={() => setImporting(false)} onImported={onChanged} /> : null}
        </div>
    );
}

type CastEditorProps = {
    projectId: string;
    episodeId?: string;
    cast: DramaCast;
    parent?: DramaCast;
    looks: DramaCast[];
    ratios: CastRatios;
    onChanged: () => void;
    onOpenCanvas: () => void;
    canvasOpening: boolean;
    layout?: "sidebar" | "workspace";
    tools?: ReactNode;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
};

export function CastEditor(props: CastEditorProps) {
    const userId = useUserStore((state) => state.user?.id);
    return <CastEditorSession key={JSON.stringify([userId, props.projectId, props.episodeId || "", props.cast.id])} {...props} />;
}

function CastEditorSession(props: CastEditorProps) {
    // 同资产保存后的表单回填不能取消尚未完成的生成；切换资产时由会话边界清理。
    const regenerationGuard = useCastRegenerationGuard(props.projectId);
    const [mainState, setMainState] = useState({ dirty: false, busy: false });
    if (props.layout !== "workspace") return <CastEditorForm {...props} regenerationGuard={regenerationGuard} />;
    return (
        <CastViewWorkspace
            projectId={props.projectId}
            episodeId={props.episodeId}
            cast={props.cast}
            disabled={mainState.dirty || mainState.busy}
            onChanged={props.onChanged}
            onDirtyChange={props.onDirtyChange}
            renderMain={(viewSelector) => (
                <CastEditorForm
                    {...props}
                    viewSelector={viewSelector}
                    regenerationGuard={regenerationGuard}
                    onDirtyChange={(dirty, busy) => {
                        setMainState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }));
                        props.onDirtyChange?.(dirty, busy);
                    }}
                />
            )}
        />
    );
}

function CastEditorForm({
    projectId,
    episodeId,
    cast,
    parent,
    looks,
    ratios,
    onChanged,
    onOpenCanvas,
    canvasOpening,
    layout = "sidebar",
    tools,
    onDirtyChange,
    regenerationGuard,
    viewSelector,
}: CastEditorProps & {
    regenerationGuard: ReturnType<typeof useCastRegenerationGuard>;
    viewSelector?: ReactNode;
}) {
    const { message, modal } = App.useApp();
    const { cancelBeforeExecution } = regenerationGuard;
    useEffect(() => () => cancelBeforeExecution(), [cancelBeforeExecution]);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const [previewing, setPreviewing] = useState(false);
    const [name, setName] = useState(cast.lookName || cast.name);
    const [aliases, setAliases] = useState(parseList(cast.aliasesJson));
    const [appearance, setAppearance] = useState(cast.appearance);
    const [voiceInstructions, setVoiceInstructions] = useState(cast.voiceInstructions);
    const [imageFields, setImageFields] = useState<CastImageFieldsValue>({ imagePrompt: cast.imagePrompt || "", imageStyleId: cast.imageStyleId || "", imageStyleName: cast.imageStyleName || "", imageStylePrompt: cast.imageStylePrompt || "" });
    const [from, setFrom] = useState<number | null>(cast.lookFromChapter || null);
    const [to, setTo] = useState<number | null>(cast.lookToChapter || null);
    const [restyle, setRestyle] = useState(true);
    const [imageOptions, setImageOptions] = useState(() => castImageOptionsDraft(cast.imageOptionsJson));
    const [baselineCast, setBaselineCast] = useState(cast);
    const summary = useQuery({ queryKey: dramaKeys.summary(projectId), queryFn: ({ signal }) => getDrama(projectId, signal) });
    const [generationNotice, setGenerationNotice] = useState<{ kind: "failed" | "uncertain" | "submitted"; text: string; version: number; resourceId?: string; saved: boolean }>();
    const [checkingGeneration, setCheckingGeneration] = useState(false);
    const [lookState, setLookState] = useState({ dirty: false, busy: false });
    const isLook = Boolean(cast.parentId);
    const snapshot = JSON.stringify({ name, aliases, appearance, voiceInstructions, ...imageFields, from: isLook ? from || 0 : 0, to: isLook ? to || 0 : 0, imageOptions });
    const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
    const dirty = snapshot !== savedSnapshot;
    const imageOptionsDirty = JSON.stringify(imageOptions) !== JSON.stringify(castImageOptionsDraft(baselineCast.imageOptionsJson));
    const fields = { name, aliases, appearance, voiceInstructions, ...imageFields };
    const saveFields = async () => {
        if (imageOptions.corrupt) throw new Error("请先重新配置无法读取的图片设置");
        if (!summary.data || typeof baselineCast.revision !== "number") throw new Error("当前作品或主体版本尚未读取，请刷新后重试");
        const revisions = { expectedRevision: summary.data.production.revision, expectedCastRevision: baselineCast.revision, imageOptions: imageOptions.options, ...(episodeId ? { episodeId } : {}) };
        if (isLook) return (await updateDramaCastLook(projectId, cast.id, { lookName: name, appearance, ...imageFields, fromChapter: from || 0, toChapter: to || 0, restyleSegments: restyle, ...revisions })).look;
        const changed: DramaCastPatch = { ...revisions };
        const baseline = {
            name: baselineCast.name,
            aliases: parseList(baselineCast.aliasesJson),
            appearance: baselineCast.appearance,
            voiceInstructions: baselineCast.voiceInstructions,
            imagePrompt: baselineCast.imagePrompt || "",
            imageStyleId: baselineCast.imageStyleId || "",
            imageStyleName: baselineCast.imageStyleName || "",
            imageStylePrompt: baselineCast.imageStylePrompt || "",
        };
        for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
            if (JSON.stringify(fields[key]) !== JSON.stringify(baseline[key])) Object.assign(changed, { [key]: fields[key] });
        }
        return (await updateDramaCast(projectId, cast.id, changed)).cast;
    };
    const acceptSaved = (updated: DramaCast) => {
        if (!mounted.current) return;
        setBaselineCast(updated);
        setSavedSnapshot(snapshot);
    };
    const acceptIndependentUpdate = useCallback((updated: DramaCast) => {
        if (!mounted.current) return;
        // 独立操作和轮询只更新媒体或锁定时接收新版本，外部表单改动仍交给保存时的版本校验。
        setBaselineCast((baseline) => (castEditorFormKey(updated) === castEditorFormKey(baseline) && (updated.revision || 0) > (baseline.revision || 0) ? updated : baseline));
    }, []);
    const save = useMutation({
        mutationFn: async () => {
            return saveFields();
        },
        onSuccess: (updated) => {
            if (!mounted.current) return;
            acceptSaved(updated);
            message.success("修改已保存");
            onChanged();
        },
        onError: (error) => {
            if (mounted.current) message.error(error instanceof Error ? error.message : "保存失败，完整草稿已保留");
        },
    });
    const lock = useMutation({
        mutationFn: (locked: boolean) => updateDramaCast(projectId, cast.id, { locked }),
        onSuccess: ({ cast: updated }) => {
            acceptIndependentUpdate(updated);
            onChanged();
        },
    });
    const regenerate = useMutation({
        mutationFn: async (isCurrent: () => boolean) => {
            let saved = false;
            if (dirty) {
                const updated = await saveFields();
                saved = true;
                if (isCurrent()) acceptSaved(updated);
            }
            if (!isCurrent()) return;
            try {
                const result = await (episodeId ? regenerateDramaCast(projectId, cast.id, restyle, episodeId) : regenerateDramaCast(projectId, cast.id, restyle));
                return { result, saved, isCurrent };
            } catch (error) {
                if (!isCurrent()) return;
                const rejected = error instanceof ApiError && [error.status, error.code].some((status) => status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429);
                const detail = error instanceof Error ? error.message : "请求未能完成";
                setGenerationNotice({ kind: rejected ? "failed" : "uncertain", text: `${saved ? "修改已保存；" : ""}${rejected ? "生成提交失败" : "生成提交结果待核对"}：${detail}`, version: cast.imageVersion, resourceId: cast.imageResourceId, saved });
                onChanged();
                return;
            }
        },
        onSuccess: (completed) => {
            if (!completed?.isCurrent()) return;
            const { result, saved } = completed;
            setGenerationNotice(undefined);
            message.success(`${saved ? "修改已保存；" : ""}${result.affectedSegments ? `正在重新生成参考图；${result.affectedSegments} 个剧情段的视频已标记为待更新` : "正在重新生成参考图"}`);
            onChanged();
        },
        onError: (error) => {
            if (mounted.current) message.error(`保存失败，未提交生成：${error instanceof Error ? error.message : "请重试"}`);
        },
    });
    // 上传或从素材库选的形象图直接成为参考图并锁定：不会被重新生成覆盖，剧情段视频按这张图生成。
    const fileRef = useRef<HTMLInputElement>(null);
    const [libraryOpen, setLibraryOpen] = useState(false);
    const imageAdopted = (result: Awaited<ReturnType<typeof setDramaCastImage>>) => {
        acceptIndependentUpdate(result.cast);
        if (result.unchanged) message.info("已在使用这张图");
        else message.success(result.affectedSegments ? `已替换并锁定形象；${result.affectedSegments} 个剧情段的视频已标记为待更新` : "已替换并锁定形象，之后的剧情段视频按这张图生成");
        onChanged();
    };
    const upload = useMutation({
        mutationFn: async (file: File) => {
            const resource = await uploadResourceFile(file, "image", { fileName: file.name });
            return setDramaCastImage(projectId, cast.id, resource.id, restyle);
        },
        onSuccess: imageAdopted,
        onError: (error) => message.error(error instanceof Error ? error.message : "上传失败"),
    });
    // 素材库选图的失败由选择弹窗内联显示，这里只处理成功。
    const adoptLibraryImage = async (resourceId: string) => imageAdopted(await setDramaCastImage(projectId, cast.id, resourceId, restyle));
    const isCharacter = cast.kind === "character" && !isLook;
    const kindLabel = isLook ? "造型" : CAST_KIND_LABEL[cast.kind];
    const saving = save.isPending || regenerate.isPending || upload.isPending || lock.isPending || lookState.busy || regenerationGuard.busy;
    const busy = saving || mediaBusy(cast.imageStatus);
    const parentReady = !isLook || (parent?.imageStatus === "ready" && Boolean(parent.imageResourceId));
    const editorState = useRef(onDirtyChange);
    editorState.current = onDirtyChange;
    useEffect(() => {
        editorState.current?.(dirty || imageOptionsDirty || lookState.dirty, saving);
    }, [dirty, imageOptionsDirty, lookState.dirty, saving]);
    useEffect(() => () => editorState.current?.(false, false), []);
    const remoteKey = castEditorFormKey(cast);
    const received = useRef(remoteKey);
    useEffect(() => {
        cancelBeforeExecution();
    }, [remoteKey, cancelBeforeExecution]);
    useEffect(() => {
        acceptIndependentUpdate(cast);
        if (dirty || busy) return;
        if (received.current === remoteKey) {
            return;
        }
        received.current = remoteKey;
        setName(cast.lookName || cast.name);
        setAliases(parseList(cast.aliasesJson));
        setAppearance(cast.appearance);
        setVoiceInstructions(cast.voiceInstructions);
        const imageFields = { imagePrompt: cast.imagePrompt || "", imageStyleId: cast.imageStyleId || "", imageStyleName: cast.imageStyleName || "", imageStylePrompt: cast.imageStylePrompt || "" };
        setImageFields(imageFields);
        setFrom(cast.lookFromChapter || null);
        setTo(cast.lookToChapter || null);
        const imageOptions = castImageOptionsDraft(cast.imageOptionsJson);
        setImageOptions(imageOptions);
        setBaselineCast(cast);
        setSavedSnapshot(
            JSON.stringify({
                name: cast.lookName || cast.name,
                aliases: parseList(cast.aliasesJson),
                appearance: cast.appearance,
                voiceInstructions: cast.voiceInstructions,
                ...imageFields,
                from: isLook ? cast.lookFromChapter || 0 : 0,
                to: isLook ? cast.lookToChapter || 0 : 0,
                imageOptions,
            }),
        );
    }, [remoteKey, dirty, busy, cast, isLook, acceptIndependentUpdate]);
    const checkGeneration = async () => {
        if (checkingGeneration || !generationNotice) return;
        setCheckingGeneration(true);
        try {
            const latest = await listDramaCast(projectId);
            if (!mounted.current) return;
            const current = latest.cast.find((item) => item.id === cast.id);
            if (current && (mediaBusy(current.imageStatus) || current.imageVersion > generationNotice.version || current.imageResourceId !== generationNotice.resourceId)) {
                setGenerationNotice({ ...generationNotice, kind: "submitted", text: `${generationNotice.saved ? "修改已保存；" : ""}已核对到生成任务或新图片，无需重复提交。` });
            } else if (current?.imageStatus === "failed") setGenerationNotice({ ...generationNotice, kind: "failed", text: `${generationNotice.saved ? "修改已保存；" : ""}生成已失败，可检查原因后重新生成。` });
            else message.info("暂未确认提交结果，请稍后再次核对；不会自动重发");
            onChanged();
        } catch (error) {
            if (mounted.current) message.error(error instanceof Error ? error.message : "生成状态读取失败");
        } finally {
            if (mounted.current) setCheckingGeneration(false);
        }
    };
    return (
        <div className={`drama-editor${layout === "workspace" ? ` is-workspace is-${cast.kind}` : ""}`}>
            <section className="drama-editor-preview" aria-label="当前参考图">
                {layout === "workspace" ? (
                    <div className="drama-editor-workspace-heading">
                        <h3>当前参考图</h3>
                        <span>{cast.imageStatus === "failed" ? "生成失败" : mediaBusy(cast.imageStatus) ? "生成中" : cast.imageStatus === "stale" ? "待更新" : cast.imageResourceId ? "已就绪" : "待生成"}</span>
                    </div>
                ) : null}
                <div className="drama-cast-hero" style={castRatio(cast.kind, ratios).style}>
                    {cast.imageResourceId ? <MediaThumb resourceId={cast.imageResourceId} alt={cast.name} loading={castImageLoading} failed={castImageFailed} /> : null}
                    {cast.imageResourceId ? (
                        <button type="button" className="drama-cast-hero-zoom" aria-label={`放大查看${cast.lookName || cast.name}的参考图`} title="点击放大查看" onClick={() => setPreviewing(true)}>
                            <span className="drama-cast-hero-zoom-hint" aria-hidden="true">
                                <Maximize2 className="size-3.5" />
                            </span>
                        </button>
                    ) : null}
                    {!cast.imageResourceId || mediaBusy(cast.imageStatus) || cast.imageStatus === "failed" ? (
                        <div className={`drama-shot-placeholder ${mediaBusy(cast.imageStatus) ? "is-busy" : ""}`}>
                            {cast.imageStatus === "failed" ? (
                                <span className="drama-cast-card-failed">
                                    <AlertCircle className="size-4" />
                                    参考图生成失败
                                </span>
                            ) : mediaBusy(cast.imageStatus) ? (
                                "参考图生成中…"
                            ) : (
                                "尚未生成参考图：确认描述后点下方生成，或上传已有的形象图"
                            )}
                        </div>
                    ) : null}
                </div>
            </section>
            <section className="drama-editor-settings" aria-label={`${kindLabel}文字与生成设置`}>
                <div className="drama-editor-row">
                    <span className="drama-eyebrow">{kindLabel}设定</span>
                    <label className="drama-switch-label">
                        <Lock className="size-3.5" />
                        锁定形象
                        <Switch size="small" checked={cast.locked} disabled={busy} loading={lock.isPending} onChange={(checked) => lock.mutate(checked)} />
                    </label>
                </div>
                <div className="drama-editor-assistance">{tools}</div>
                <div className="drama-editor-text-settings">
                    {isLook ? <p className="drama-editor-note">所属角色：{parent?.name || cast.name}。造型使用角色的多视图参考图方案，服装、年龄和风格可独立设置。</p> : null}
                    {cast.sourceProjectId ? (
                        <p className="drama-editor-note">
                            <Link2 className="inline size-3.5" /> 已关联其他作品素材，当前设定可独立编辑。
                        </p>
                    ) : null}
                    <Field label={isLook ? "造型名称" : "名称"}>
                        <Input value={name} maxLength={60} disabled={busy} onChange={(event) => setName(event.target.value)} aria-label={isLook ? "造型名称" : "名称"} />
                    </Field>
                    {isCharacter ? (
                        <Field label="别名与称呼" hint="剧本里这些称呼都会归到此角色">
                            <Select mode="tags" className="w-full" value={aliases} disabled={busy} onChange={setAliases} tokenSeparators={[",", "，", "、"]} placeholder="输入后回车" open={false} suffixIcon={null} aria-label="别名与称呼" />
                        </Field>
                    ) : null}
                    <Field label={APPEARANCE_LABEL[cast.kind]} hint="用于参考图与剧情段视频提示词">
                        <Input.TextArea value={appearance} maxLength={1000} disabled={busy} autoSize={{ minRows: 4, maxRows: 10 }} onChange={(event) => setAppearance(event.target.value)} aria-label={APPEARANCE_LABEL[cast.kind]} />
                    </Field>
                    {isLook ? (
                        <Field label="默认适用章节" hint="留空表示不限，按本季原著章节设置">
                            <div className="drama-look-form-range">
                                <InputNumber aria-label="造型起始章" min={0} precision={0} value={from} placeholder="起始章" disabled={busy} onChange={setFrom} />
                                <span>至</span>
                                <InputNumber aria-label="造型结束章" min={0} precision={0} value={to} placeholder="结束章" disabled={busy} onChange={setTo} />
                            </div>
                        </Field>
                    ) : null}
                    {isCharacter ? (
                        <Field label="声线" hint="写进视频提示词，由视频模型生成对白">
                            <Input value={voiceInstructions} disabled={busy} placeholder="少年音，坚毅，语速偏快" onChange={(event) => setVoiceInstructions(event.target.value)} aria-label="声线" />
                        </Field>
                    ) : null}
                    {isCharacter ? (
                        <Field label="声音样本" hint="支持参考音频的视频模型会在该角色开口的剧情段带上这段声音">
                            <CastVoiceField
                                projectId={projectId}
                                cast={cast}
                                restyle={restyle}
                                onChanged={(updated) => {
                                    acceptIndependentUpdate(updated);
                                    onChanged();
                                }}
                            />
                        </Field>
                    ) : null}
                    <div className="drama-editor-impact">
                        <Checkbox checked={restyle} disabled={busy} onChange={(event) => setRestyle(event.target.checked)}>
                            将引用视频标记为待更新
                        </Checkbox>
                    </div>
                    {dirty || imageOptionsDirty || lookState.dirty ? (
                        <p className="drama-editor-note" role="status">
                            有未保存的修改。文字、提示词与图片配置将一并保存。
                        </p>
                    ) : null}
                </div>
                <div className="drama-editor-image-settings">
                    {layout === "workspace" ? <h3>生图设置</h3> : null}
                    <CastImageOptions projectId={projectId} episodeId={episodeId} cast={cast} disabled={busy} onChanged={onChanged} value={imageOptions} onChange={setImageOptions} />
                    <CastImageFields projectId={projectId} episodeId={episodeId} castId={cast.id} appearance={appearance} value={imageFields} disabled={busy} onChange={(patch) => setImageFields((current) => ({ ...current, ...patch }))} />
                </div>
            </section>
            <div className="drama-editor-actions">
                <Button
                    className="drama-editor-wide"
                    disabled={!dirty || busy || imageOptions.corrupt || !name.trim() || !appearance.trim() || !summary.data || typeof baselineCast.revision !== "number"}
                    loading={save.isPending}
                    onClick={() => save.mutate()}
                >
                    保存修改
                </Button>
                {generationNotice ? (
                    <div className="drama-editor-note" role={generationNotice.kind === "submitted" ? "status" : "alert"}>
                        <p>{generationNotice.text}</p>
                        {generationNotice.kind === "uncertain" ? (
                            <Button loading={checkingGeneration} onClick={() => void checkGeneration()}>
                                核对生成状态
                            </Button>
                        ) : null}
                    </div>
                ) : null}
                <Button icon={<Upload className="size-4" />} disabled={busy} loading={upload.isPending} onClick={() => fileRef.current?.click()}>
                    上传形象图
                </Button>
                <Button className="drama-editor-wide" icon={<FolderOpen className="size-4" />} disabled={busy} onClick={() => setLibraryOpen(true)}>
                    从素材库选择
                </Button>
                {libraryOpen ? <CastLibraryPicker open={libraryOpen} cast={cast} onClose={() => setLibraryOpen(false)} onPick={adoptLibraryImage} /> : null}
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    aria-label={`上传${cast.name}的形象图`}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        if (!file.type.startsWith("image/")) {
                            message.warning("请选择 PNG、JPG 或 WebP 图片");
                            return;
                        }
                        if (file.size > 20 * 1024 * 1024) {
                            message.warning("图片不超过 20MB");
                            return;
                        }
                        upload.mutate(file);
                    }}
                />
                <Button
                    type="primary"
                    className="drama-editor-wide"
                    icon={<RefreshCw className="size-4" />}
                    disabled={cast.locked || busy || imageOptions.corrupt || generationNotice?.kind === "uncertain" || !parentReady || !name.trim() || !appearance.trim() || (dirty && (!summary.data || typeof baselineCast.revision !== "number"))}
                    title={!parentReady ? "请先生成或上传角色本体图" : undefined}
                    loading={regenerate.isPending || regenerationGuard.busy}
                    onClick={() => void regenerationGuard.request({ castId: cast.id, name: cast.lookName || cast.name, restyleSegments: restyle, execute: (isCurrent) => regenerate.mutateAsync(isCurrent) })}
                >
                    {cast.imageResourceId ? (dirty ? "保存并重新生成" : "重新生成") : dirty ? "保存并生成参考图" : "生成参考图"}
                </Button>
                <Button
                    className="drama-editor-wide"
                    icon={<Brush className="size-4" />}
                    disabled={dirty || imageOptionsDirty || busy}
                    title={dirty || imageOptionsDirty ? "请先保存设定与图片生成配置" : undefined}
                    loading={canvasOpening}
                    onClick={onOpenCanvas}
                >
                    在画布中精修
                </Button>
                {isLook ? (
                    <Button
                        danger
                        className="drama-editor-wide"
                        icon={<Trash2 className="size-4" />}
                        disabled={busy}
                        onClick={() =>
                            modal.confirm({
                                title: `删除造型「${cast.lookName}」？`,
                                content: "引用这套造型的镜头将回到角色基础造型。",
                                okText: "删除造型",
                                cancelText: "取消",
                                onOk: async () => {
                                    await deleteDramaCastLook(projectId, cast.id, restyle);
                                    onChanged();
                                },
                            })
                        }
                    >
                        删除造型
                    </Button>
                ) : null}
            </div>
            <section className="drama-editor-extras" aria-label="造型与独立视图">
                {layout === "workspace" ? (
                    <div className="drama-editor-workspace-heading">
                        <h3>{isCharacter ? "造型与多视图" : "资产多视图"}</h3>
                        <span>按需补充，独立保存与生成</span>
                    </div>
                ) : null}
                {viewSelector || <CastViews projectId={projectId} episodeId={episodeId} cast={cast} disabled={busy || dirty || imageOptionsDirty} onChanged={onChanged} />}
                {isCharacter ? (
                    <CastLooks
                        projectId={projectId}
                        episodeId={episodeId}
                        character={cast}
                        looks={looks}
                        restyle={restyle}
                        onChanged={onChanged}
                        onDirtyChange={(dirty, busy) => setLookState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                    />
                ) : null}
                <p className="drama-editor-note">上传或从画布采用的形象图会自动锁定。旧图片保留在版本记录中，锁定后需先解锁再重新生成。</p>
            </section>
            <aside className="drama-editor-history" aria-label="参考图历史">
                {layout === "workspace" ? (
                    <div className="drama-editor-workspace-heading">
                        <h3>版本记录</h3>
                    </div>
                ) : null}
                <DramaTakeList projectId={projectId} ownerId={cast.id} kind="cast" showHeading={layout !== "workspace"} />
                {layout === "workspace" ? <p className="drama-editor-note">生成、上传与画布精修产生的图片会保留在这里。</p> : null}
            </aside>
            {previewing && cast.imageResourceId ? <CanvasImagePreview storageKey={`resource:${cast.imageResourceId}`} alt={`${cast.lookName || cast.name} · ${kindLabel}参考图`} onClose={() => setPreviewing(false)} /> : null}
        </div>
    );
}

const APPEARANCE_LABEL: Record<DramaCastKind, string> = { character: "外貌描述", prop: "外形描述", scene: "环境描述" };

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="drama-field">
            <div className="drama-field-label">
                <span>{label}</span>
                {hint ? <small>{hint}</small> : null}
            </div>
            {children}
        </div>
    );
}

// ===== 待处理 =====

type InboxGroup = {
    key: string;
    kind: DramaInboxItem["kind"];
    severity: DramaInboxItem["severity"];
    title: string;
    reason: string;
    items: DramaInboxItem[];
};

const KIND_ORDER: DramaInboxItem["kind"][] = ["paused", "media_ready", "review", "episode_error", "cast_failed", "segment_failed"];
const MEDIA_LABEL: Record<NonNullable<DramaInboxItem["media"]>, string> = { prompt: "提示词", video: "视频" };

/** 同类、同原因的问题折叠成一组：12 个角色同样的失败只占一张卡。 */
function groupInbox(items: DramaInboxItem[]): InboxGroup[] {
    const groups = new Map<string, InboxGroup>();
    for (const item of items) {
        const reason = item.kind === "review" ? "" : item.detail;
        const key = [item.kind, item.castKind || "", item.media || "", reason].join("|");
        const group = groups.get(key);
        if (group) group.items.push(item);
        else groups.set(key, { key, kind: item.kind, severity: item.severity, title: "", reason, items: [item] });
    }
    for (const group of groups.values()) {
        const count = group.items.length;
        const first = group.items[0];
        if (group.kind === "paused") group.title = "制作已暂停";
        else if (group.kind === "media_ready") group.title = first.title;
        else if (group.kind === "review") group.title = count > 1 ? `${count} 集视频提示词等待审阅` : first.title;
        else if (group.kind === "episode_error") group.title = count > 1 ? `${count} 集改编遇到问题` : first.title;
        else if (group.kind === "cast_failed") group.title = `${count} 个${CAST_KIND_LABEL[first.castKind || "character"]}参考图生成失败`;
        else group.title = `${count} 个剧情段${MEDIA_LABEL[first.media || "video"]}生成失败`;
    }
    return [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.items.length - a.items.length);
}

const GROUP_ICON: Record<DramaInboxItem["kind"], ReactNode> = {
    paused: <PauseCircle className="size-[18px]" />,
    media_ready: <PackageCheck className="size-[18px]" />,
    review: <CheckCheck className="size-[18px]" />,
    episode_error: <ScrollText className="size-[18px]" />,
    cast_failed: <UserRound className="size-[18px]" />,
    segment_failed: <Film className="size-[18px]" />,
};

const MEDIA_ICON: Record<NonNullable<DramaInboxItem["media"]>, ReactNode> = {
    prompt: <ScrollText className="size-3" />,
    video: <Film className="size-3" />,
};

const CHIP_LIMIT = 24;

export function InboxPanel({
    items,
    castById,
    retrying,
    retryingGroup,
    releasing,
    onRetryAll,
    onRetryGroup,
    onOpen,
    onOpenSettings,
    onReleaseAll,
}: {
    items: DramaInboxItem[];
    castById: Map<string, DramaCast>;
    retrying: boolean;
    retryingGroup: string;
    onRetryAll: () => void;
    onRetryGroup: (key: string, items: DramaInboxItem[]) => void;
    onOpen: (item: DramaInboxItem) => void;
    onOpenSettings: () => void;
    releasing: boolean;
    onReleaseAll: () => void;
}) {
    const groups = useMemo(() => groupInbox(items), [items]);
    const failures = items.filter((item) => item.severity === "error").length;
    const reviews = items.filter((item) => item.kind === "review").length;
    return (
        <div className="drama-view">
            <section className="drama-view-main">
                <div className="drama-view-head">
                    <h2 className="drama-view-title">待处理</h2>
                    {items.length ? (
                        <div className="drama-inbox-summary">
                            {failures ? (
                                <span className="is-err">
                                    <AlertCircle className="size-3.5" />
                                    {failures} 项失败
                                </span>
                            ) : null}
                            {reviews ? (
                                <span className="is-info">
                                    <CheckCheck className="size-3.5" />
                                    {reviews} 集待审阅
                                </span>
                            ) : null}
                            <span>共 {groups.length} 类</span>
                        </div>
                    ) : null}
                    {failures ? (
                        <Button className="!ml-auto" icon={<RotateCcw className="size-4" />} loading={retrying} onClick={onRetryAll}>
                            全部重试
                        </Button>
                    ) : null}
                </div>
                <div className="drama-view-scroll thin-scrollbar">
                    {groups.length ? (
                        <div className="drama-inbox">
                            {groups.map((group) => {
                                const retryable = group.kind === "cast_failed" || group.kind === "segment_failed";
                                return (
                                    <article key={group.key} className={`drama-inbox-card is-${group.severity}`}>
                                        <header className="drama-inbox-card-head">
                                            <span className={`drama-inbox-icon is-${group.severity}`}>{GROUP_ICON[group.kind]}</span>
                                            <div className="min-w-0 flex-1">
                                                <h3>{group.title}</h3>
                                                {group.kind === "review" ? (
                                                    <p>核对各段视频提示词与参考图后继续生成视频</p>
                                                ) : group.kind === "cast_failed" ? (
                                                    <p>可修改外观描述后重新生成，或直接重试</p>
                                                ) : group.kind === "media_ready" ? (
                                                    <p>{group.items[0].detail}</p>
                                                ) : null}
                                            </div>
                                            <div className="drama-inbox-card-actions">
                                                {group.kind === "paused" ? (
                                                    <Button size="small" onClick={onOpenSettings}>
                                                        去设置
                                                    </Button>
                                                ) : null}
                                                {group.kind === "media_ready" ? (
                                                    <Button size="small" type="primary" icon={<Play className="size-3.5" />} loading={releasing} onClick={onReleaseAll}>
                                                        全部开始生成
                                                    </Button>
                                                ) : null}
                                                {retryable ? (
                                                    <Button size="small" icon={<RotateCcw className="size-3.5" />} loading={retryingGroup === group.key} onClick={() => onRetryGroup(group.key, group.items)}>
                                                        重试{group.items.length > 1 ? ` ${group.items.length} 项` : ""}
                                                    </Button>
                                                ) : null}
                                                {group.items.length === 1 && group.kind !== "paused" && group.kind !== "media_ready" ? (
                                                    <Button size="small" type={group.kind === "review" ? "primary" : "default"} onClick={() => onOpen(group.items[0])}>
                                                        {group.kind === "review" ? "去审阅" : "查看"}
                                                        <ArrowRight className="size-3.5" />
                                                    </Button>
                                                ) : null}
                                            </div>
                                        </header>
                                        {group.reason && group.kind !== "media_ready" ? (
                                            <div className="drama-inbox-reason" title={group.reason}>
                                                <span>原因</span>
                                                <code>{group.reason}</code>
                                            </div>
                                        ) : null}
                                        {group.items.length > 1 || group.kind === "cast_failed" ? (
                                            <div className="drama-inbox-chips">
                                                {group.items.slice(0, CHIP_LIMIT).map((item) => (
                                                    <InboxChip key={item.id} item={item} cast={item.castId ? castById.get(item.castId) : undefined} onOpen={onOpen} />
                                                ))}
                                                {group.items.length > CHIP_LIMIT ? <span className="drama-inbox-more">另有 {group.items.length - CHIP_LIMIT} 项</span> : null}
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="drama-empty is-tall">
                            <Inbox className="size-8" />
                            <strong>一切顺利</strong>
                            <span>没有需要你处理的事项，流水线会在需要确认或出错时提醒你。</span>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

function InboxChip({ item, cast, onOpen }: { item: DramaInboxItem; cast?: DramaCast; onOpen: (item: DramaInboxItem) => void }) {
    let content: ReactNode;
    if (item.kind === "cast_failed") {
        content = (
            <>
                <span className="drama-avatar">{cast?.imageResourceId ? <MediaThumb resourceId={cast.imageResourceId} alt="" /> : item.title.slice(0, 1)}</span>
                {item.title}
            </>
        );
    } else if (item.kind === "segment_failed") {
        content = (
            <>
                {item.media ? MEDIA_ICON[item.media] : null}第 {item.episodeNumber} 集 · 第 {item.segmentIndex + 1} 段
            </>
        );
    } else if (item.kind === "review") {
        content = (
            <>
                <Clapperboard className="size-3" />
                {item.title}
            </>
        );
    } else {
        content = item.title;
    }
    return (
        <button type="button" className={`drama-inbox-chip ${item.kind === "cast_failed" ? "has-avatar" : ""}`} title={item.detail} onClick={() => onOpen(item)}>
            {content}
        </button>
    );
}

// ===== 制作设置 =====

const CAPABILITY_META: Record<DramaCapability, { label: string; hint: string }> = {
    text: { label: "默认文本", hint: "分集规划，及没有单独指定模型的文字步骤" },
    image: { label: "默认图片", hint: "没有单独指定模型的参考图" },
    video: { label: "剧情段视频", hint: "每段一个带对白与音效的视频，可按段换模型" },
};
const REVIEW_LABEL: Record<DramaReviewMode, { title: string; detail: string }> = {
    sample: { title: "先看样片", detail: "第 1 集成片确认后继续其余集" },
    every: { title: "每集确认", detail: "每集生成视频前停下来审阅段视频提示词" },
    auto: { title: "全自动", detail: "不打断，直接跑到成片" },
};
const CONCURRENCY = [2, 4, 6, 8, 12, 16];

export function SettingsPanel({ projectId, summary, cast, onChanged }: { projectId: string; summary: DramaSummary; cast: DramaCast[]; onChanged: () => void }) {
    const { message, modal } = App.useApp();
    const current = summary.production.settings;
    const [settings, setSettings] = useState(current);
    const [budget, setBudget] = useState(summary.production.budgetMicrocredits / 1_000_000);
    useEffect(() => {
        setSettings(summary.production.settings);
        setBudget(summary.production.budgetMicrocredits / 1_000_000);
    }, [summary.production.settings, summary.production.budgetMicrocredits]);
    const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(current) || Math.round(budget * 1_000_000) !== summary.production.budgetMicrocredits, [budget, current, settings, summary.production.budgetMicrocredits]);
    const save = useMutation({
        mutationFn: () => updateDramaSettings(projectId, { settings, budgetMicrocredits: Math.max(0, Math.round((budget || 0) * 1_000_000)) }),
        onSuccess: () => {
            message.success("设置已保存，新任务会使用新配置");
            onChanged();
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });
    const [restyleSegments, setRestyleSegments] = useState(true);
    const regenerateAll = useMutation({
        mutationFn: (kind: DramaCastKind) => regenerateDramaCasts(projectId, kind, restyleSegments),
        onSuccess: (result, kind) => {
            message.success(
                `已按当前方案重做 ${result.queued} 个${CAST_KIND_LABEL[kind]}参考图${result.skipped ? `，${result.skipped} 个已锁定或正在生成` : ""}${result.affectedSegments ? `，${result.affectedSegments} 个剧情段的视频已标记为待更新` : ""}`,
            );
            onChanged();
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "操作失败"),
    });
    const catalogQuery = useDramaModelCatalog();
    const videoOptionFor = (choice?: DramaModelChoice) => catalogQuery.data?.options.video?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(choice));
    const videoOption = videoOptionFor(settings.models.video);
    // 角色参考图用单独指定的模型，没有就用默认图片模型；参考图方案按它检查角色画幅。
    const characterImage = dramaChoiceKey(settings.models.characterImage) ? settings.models.characterImage : settings.models.image;
    const imageOption = catalogQuery.data?.options.image?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(characterImage));
    const videoRatioProblem = dramaVideoRatioIssue(videoOption, current.aspectRatio);
    const videoResolutionProblem = dramaVideoResolutionIssue(videoOption, settings.videoResolution);
    const setModels = (patch: Partial<DramaSettings["models"]>) => setSettings({ ...settings, models: { ...settings.models, ...patch } });
    const setModelChoice = (capability: DramaCapability, choice: DramaModelChoice) => {
        if (capability !== "video") {
            setModels({ [capability]: choice });
            return;
        }
        // 视频模型与分辨率一起更新：新模型支持就保留，不支持就清空，按新模型默认档出片。
        const next = videoOptionFor(choice);
        setSettings({ ...settings, models: { ...settings.models, video: choice }, ...(next ? { videoResolution: dramaResolutionAfterModelChange(next, settings.videoResolution) } : {}) });
    };
    const continuity: DramaVideoContinuity = settings.videoContinuity || "tail_frame";
    const sampleCharacter = cast.find((item) => item.kind === "character" && item.appearance);
    const sampleScene = cast.find((item) => item.kind === "scene" && item.appearance);
    const countOf = (kind: DramaCastKind) => cast.filter((item) => item.kind === kind).length;
    const spent = summary.production.spentMicrocredits;
    const held = summary.production.heldMicrocredits || 0;
    const budgetMicro = Math.round((budget || 0) * 1_000_000);
    // 预算占用与后端判断同一口径：已扣费加冻结中的订单。
    const usage = budgetMicro > 0 ? Math.min(1, (spent + held) / budgetMicro) : 0;
    return (
        <div className="drama-view">
            <section className="drama-view-main">
                <div className="drama-view-head">
                    <h2 className="drama-view-title">制作设置</h2>
                    <span className="drama-view-sub">{dirty ? "有未保存的修改" : "修改只影响之后新开始的任务"}</span>
                    <div className="ml-auto flex gap-2">
                        <Button
                            disabled={!dirty}
                            onClick={() => {
                                setSettings(current);
                                setBudget(summary.production.budgetMicrocredits / 1_000_000);
                            }}
                        >
                            还原
                        </Button>
                        <Button type="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                            保存设置
                        </Button>
                    </div>
                </div>
                <div className="drama-view-scroll thin-scrollbar">
                    <div className="drama-cfg">
                        <div className="drama-cfg-main">
                            <EpisodeModeCard summary={summary} settings={settings} onChange={(patch) => setSettings({ ...settings, ...patch })} />
                            <section className="drama-cfg-card">
                                <SettingsTitle title="分镜规则" detail="对之后改编的集生效；已改编的集可在剧本页“重新改编”" icon={<Clapperboard className="size-4" />} />
                                <StoryboardRules
                                    value={settings.storyboard}
                                    onChange={(storyboard) => setSettings({ ...settings, storyboard })}
                                    episodeSeconds={settings.episodeSeconds}
                                    onEpisodeSecondsChange={(episodeSeconds) => setSettings({ ...settings, episodeSeconds })}
                                    maxVideoSeconds={videoOption?.maxVideoSeconds}
                                    videoModelLabel={settings.models.video?.label}
                                    bare
                                />
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="文字步骤" detail="每一步可以单独设置思考意图、文本模型和写作技能；思考等级按实际使用模型的能力归一化，对之后执行的步骤生效" icon={<ScrollText className="size-4" />} />
                                <DramaTextSteps
                                    models={settings.models}
                                    onModelsChange={setModels}
                                    skills={{ bible: settings.bibleSkill, script: settings.scriptSkill, prompt: settings.promptSkill }}
                                    onSkillChange={(step, value) => setSettings({ ...settings, [step === "bible" ? "bibleSkill" : step === "script" ? "scriptSkill" : "promptSkill"]: value })}
                                    textThinking={settings.textThinking || {}}
                                    onThinkingChange={(step, level) => setSettings({ ...settings, textThinking: { ...settings.textThinking, [step]: level === "auto" ? undefined : level } as DramaTextThinking })}
                                />
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="参考图" detail="参考图随剧情段视频请求一起发送，是人物与道具保持一致的锚点；角色、道具、场景可以用不同的图片模型与分辨率，修改只影响之后生成的参考图" icon={<UsersRound className="size-4" />} />
                                <DramaAssetImageModels models={settings.models} onModelsChange={setModels} assets={settings.assets} onAssetsChange={(assets) => setSettings({ ...settings, assets })} />
                                <AssetSchemePicker
                                    value={settings.assets}
                                    onChange={(assets) => setSettings({ ...settings, assets })}
                                    sample={{ style: settings.stylePrompt, characterName: sampleCharacter?.name, characterAppearance: sampleCharacter?.appearance, sceneName: sampleScene?.name, sceneAppearance: sampleScene?.appearance }}
                                    imageModel={imageOption}
                                />
                                <div className="drama-settings-regen">
                                    <div>
                                        <strong>按当前方案重做已有参考图</strong>
                                        <span>
                                            {CAST_KINDS.map((kind) => `${countOf(kind)} 个${CAST_KIND_LABEL[kind]}`).join(" · ")}；锁定的设定不会变。{dirty ? "请先保存设置。" : ""}
                                        </span>
                                    </div>
                                    <Checkbox checked={restyleSegments} onChange={(event) => setRestyleSegments(event.target.checked)}>
                                        将引用视频标记为待更新
                                    </Checkbox>
                                    {CAST_KINDS.map((kind) => (
                                        <Button
                                            key={kind}
                                            disabled={dirty || !countOf(kind)}
                                            loading={regenerateAll.isPending && regenerateAll.variables === kind}
                                            onClick={() =>
                                                modal.confirm({
                                                    title: `按当前方案重做 ${countOf(kind)} 个${CAST_KIND_LABEL[kind]}参考图？`,
                                                    content: `每张参考图都会重新生成并计费${restyleSegments ? "，引用它们的视频将标记为待更新" : ""}。旧版本保留在版本记录中。`,
                                                    okText: "开始重做",
                                                    cancelText: "取消",
                                                    centered: true,
                                                    onOk: () => regenerateAll.mutateAsync(kind),
                                                })
                                            }
                                        >
                                            重做{CAST_KIND_LABEL[kind]}
                                        </Button>
                                    ))}
                                </div>
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="制作模型" detail="只列出平台可无人值守执行的模型" icon={<Cpu className="size-4" />} />
                                <div className="drama-cfg-models">
                                    {(Object.keys(CAPABILITY_META) as DramaCapability[]).map((capability) => (
                                        <div key={capability} className="drama-cfg-model">
                                            <div className="drama-cfg-model-label">
                                                <strong>{CAPABILITY_META[capability].label}</strong>
                                                <small>{CAPABILITY_META[capability].hint}</small>
                                            </div>
                                            <DramaModelPicker
                                                capability={capability}
                                                value={settings.models[capability]}
                                                aspectRatio={current.aspectRatio}
                                                placeholder={`选择${CAPABILITY_META[capability].label}模型`}
                                                onChange={(choice) => setModelChoice(capability, choice)}
                                            />
                                        </div>
                                    ))}
                                    <div className="drama-cfg-model">
                                        <div className="drama-cfg-model-label">
                                            <strong>视频分辨率</strong>
                                            <small>对之后提交的剧情段视频生效</small>
                                        </div>
                                        <VideoResolutionField option={videoOption} value={settings.videoResolution} onChange={(videoResolution) => setSettings({ ...settings, videoResolution })} />
                                    </div>
                                </div>
                                {videoRatioProblem ? <p className="drama-cfg-note">当前视频模型{videoRatioProblem}，剧情段视频无法提交，请换模型。</p> : null}
                                {videoResolutionProblem ? (
                                    <p className="drama-cfg-note">
                                        当前视频模型{videoResolutionProblem}，实际按模型默认{videoOption?.defaultVideoResolution ? ` ${formatVideoResolutionLabel(videoOption.defaultVideoResolution)}` : ""}出片。
                                    </p>
                                ) : null}
                                {videoOption?.generateAudio === false ? <p className="drama-cfg-note">当前视频模型不同步生成声音，剧情段视频没有对白与音效。</p> : null}
                            </section>
                        </div>
                        <aside className="drama-cfg-side">
                            <section className="drama-cfg-card">
                                <SettingsTitle title="作品" detail="开工时确定" />
                                <dl className="drama-cfg-kv">
                                    <div>
                                        <dt>画幅</dt>
                                        <dd>{current.aspectRatio}</dd>
                                    </div>
                                    <div>
                                        <dt>视觉风格</dt>
                                        <dd title={current.styleName}>{current.styleName || "—"}</dd>
                                    </div>
                                    <div>
                                        <dt>对白语言</dt>
                                        <dd>{current.language}</dd>
                                    </div>
                                </dl>
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="审阅方式" detail="只在关键点打断你" />
                                <CompactRadios
                                    label="审阅方式"
                                    value={settings.reviewMode}
                                    options={(Object.keys(REVIEW_LABEL) as DramaReviewMode[]).map((mode) => ({ value: mode, ...REVIEW_LABEL[mode] }))}
                                    onChange={(reviewMode) => setSettings({ ...settings, reviewMode })}
                                />
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="生成节奏" detail={settings.mediaMode === "manual" ? `${summary.episodes.filter((episode) => episode.awaitingMedia).length} 集等待生成视频` : undefined} />
                                <CompactRadios
                                    label="生成节奏"
                                    value={settings.mediaMode}
                                    options={(Object.keys(MEDIA_MODE_LABEL) as DramaMediaMode[]).map((mode) => ({ value: mode, ...MEDIA_MODE_LABEL[mode] }))}
                                    onChange={(mediaMode) => setSettings({ ...settings, mediaMode })}
                                />
                                {settings.mediaMode !== current.mediaMode && settings.mediaMode === "manual" ? <p className="drama-cfg-note">改为手动后，未放行的集停在当前阶段，已提交的任务会做完。</p> : null}
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="段落衔接" detail="决定同一集的剧情段能否同时生成" />
                                <CompactRadios
                                    label="段落衔接"
                                    value={continuity}
                                    options={(Object.keys(VIDEO_CONTINUITY_LABEL) as DramaVideoContinuity[]).map((mode) => ({ value: mode, ...VIDEO_CONTINUITY_LABEL[mode] }))}
                                    onChange={(videoContinuity) => setSettings({ ...settings, videoContinuity })}
                                />
                                {continuity === "tail_frame" && videoOption && !videoOption.tailFrameChain ? <p className="drama-cfg-note">当前视频模型不支持图生视频，无法尾帧续接，请改用并行出片或换模型。</p> : null}
                                {continuity !== (current.videoContinuity || "tail_frame") ? <p className="drama-cfg-note">已写好的段视频提示词按原方式撰写，切换后可在剧情段里重新撰写；已提交的视频会做完。</p> : null}
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="同时生成数" detail="文字、参考图、段视频分别计算，受账号并发上限约束" />
                                <div className="drama-tabs drama-cfg-seg" role="radiogroup" aria-label="同时生成数">
                                    {CONCURRENCY.map((value) => (
                                        <button key={value} type="button" role="radio" className="drama-tab" aria-checked={settings.concurrency === value} onClick={() => setSettings({ ...settings, concurrency: value })}>
                                            {value}
                                        </button>
                                    ))}
                                </div>
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="每段最多参考图" detail="自动取参考图时的上限，人物优先；0 为按视频模型上限" />
                                <InputNumber className="!w-full" min={0} max={20} precision={0} value={settings.referenceLimit || 0} onChange={(value) => setSettings({ ...settings, referenceLimit: value || 0 })} suffix="张" aria-label="每段最多参考图" />
                                <p className="drama-cfg-note">超出的设定按文字描述生成，不附图。个别段需要更多参考图时，在剧情段弹窗里手动指定，只受模型上限约束。</p>
                            </section>
                            <section className="drama-cfg-card">
                                <SettingsTitle title="预算上限" detail="0 表示不限，含精修画布花费；达到后暂停，画布上也不能再生成" />
                                <InputNumber className="!w-full" min={0} precision={0} value={budget} onChange={(value) => setBudget(value || 0)} suffix="积分" aria-label="预算上限" />
                                <div className="drama-budget-meter">
                                    <div className="drama-budget-track">
                                        <span className={usage >= 0.9 ? "is-warn" : ""} style={progressFillStyle(budgetMicro ? Math.max(usage * 100, spent + held ? 2 : 0) : 0)} />
                                    </div>
                                    <span>
                                        已花费 <b>{formatCredits(spent)}</b>
                                        {held > 0 ? ` · 冻结中 ${formatCredits(held)}` : ""}
                                        {budgetMicro ? ` / ${formatCredits(budgetMicro)}` : " · 不限预算"}
                                    </span>
                                </div>
                                {summary.production.canvasSpentMicrocredits > 0 ? (
                                    <p className="drama-cfg-note">
                                        其中流水线 {formatCredits(Math.max(0, spent - summary.production.canvasSpentMicrocredits))}，精修画布 {formatCredits(summary.production.canvasSpentMicrocredits)}。
                                    </p>
                                ) : null}
                            </section>
                        </aside>
                    </div>
                </div>
            </section>
        </div>
    );
}

const EPISODE_MODE_OPTIONS: Array<{ value: DramaEpisodeMode; title: string; detail: string }> = [
    { value: "chapter", title: "按章分集", detail: "按章节顺序固定分集，每 N 章一集" },
    { value: "auto", title: "模型自动分集", detail: "按剧情把章节规划成集，可合并或拆分章节" },
];

/**
 * 分集方式：只影响还没分集的章节。分集完成后已有的集可能写好了剧本，不再重新分组，
 * 之后用“逐集追加”继续；剧本与分镜作品总是每章一集。
 */
function EpisodeModeCard({ summary, settings, onChange }: { summary: DramaSummary; settings: DramaSettings; onChange: (patch: Pick<DramaSettings, "episodeMode" | "chaptersPerEpisode">) => void }) {
    const { production, episodes } = summary;
    const novel = (summary.project.sourceType || "novel") === "novel";
    const editable = novel && !production.planDone;
    const mode = settings.episodeMode || (production.planDone ? undefined : "auto");
    const perEpisode = settings.chaptersPerEpisode || 1;
    const current = !novel ? "每章一集（剧本与分镜按标题分集）" : settings.episodeMode === "chapter" ? (perEpisode > 1 ? `按章分集 · 每 ${perEpisode} 章一集` : "按章分集 · 每章一集") : settings.episodeMode === "auto" ? "模型自动分集" : "已分集";
    return (
        <section className="drama-cfg-card">
            <SettingsTitle title="分集方式" detail={editable ? "只影响还没分集的章节，保存后下一轮调度生效" : "分集已完成，不能再调整；之后可在制作台逐集追加新的一集"} icon={<Film className="size-4" />} />
            {editable ? (
                <div className="grid gap-3">
                    <CompactRadios label="分集方式" value={mode || "auto"} options={EPISODE_MODE_OPTIONS} onChange={(value) => onChange({ episodeMode: value, chaptersPerEpisode: value === "chapter" ? perEpisode : undefined })} />
                    {mode === "chapter" ? <EpisodeGroupField value={perEpisode} onChange={(value) => onChange({ episodeMode: "chapter", chaptersPerEpisode: value })} chapterCount={Math.max(0, production.chapterCount - production.planCursor)} /> : null}
                    {production.planCursor > 0 ? (
                        <p className="drama-cfg-note">
                            前 {production.planCursor} 章已分成 {episodes.length} 集，保持不变。
                        </p>
                    ) : null}
                </div>
            ) : (
                <p className="drama-cfg-note">
                    {current} · 共 {production.chapterCount} 章 {episodes.length} 集
                </p>
            )}
        </section>
    );
}

/** 侧栏里的紧凑单选列表：一行标题，说明作为次要文字，选中态只改边框和底色。 */
function CompactRadios<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: Array<{ value: V; title: string; detail: string }>; onChange: (value: V) => void }) {
    return (
        <div className="drama-cfg-radios" role="radiogroup" aria-label={label}>
            {options.map((option) => (
                <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className="drama-cfg-radio" onClick={() => onChange(option.value)}>
                    <span className="drama-radio" aria-hidden />
                    <span className="min-w-0">
                        <strong>{option.title}</strong>
                        <small>{option.detail}</small>
                    </span>
                </button>
            ))}
        </div>
    );
}

function SettingsTitle({ title, detail, icon }: { title: string; detail?: string; icon?: ReactNode }) {
    return (
        <div className="drama-settings-title">
            <h3>
                {icon}
                {title}
            </h3>
            {detail ? <span>{detail}</span> : null}
        </div>
    );
}
