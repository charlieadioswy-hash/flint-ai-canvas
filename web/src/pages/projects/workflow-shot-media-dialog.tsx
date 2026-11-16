import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Select, Switch } from "antd";
import { ImagePlus, RefreshCw, Trash2 } from "lucide-react";

import { AssetLibraryPickerModal } from "@/components/assets/asset-library-picker-modal";
import { AppModal } from "@/components/ui/product/app-modal";
import { dramaChoiceKey } from "@/lib/drama/model-choice";
import { formatDramaCredits } from "@/lib/drama/drama-format";
import { CAMERA_PRESETS } from "@/lib/drama/director";
import type { DramaShot } from "@/services/api/drama";
import {
    adoptDramaShotMedia,
    executeDramaShotMedia,
    getDramaShotMedia,
    preflightDramaShotMedia,
    saveDramaShotMedia,
    type DramaShotMedia,
    type DramaShotMediaAction,
    type DramaShotMediaConfig,
    type DramaShotMediaKind,
    type DramaShotMediaPreflight,
} from "@/services/api/drama-shot-media";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { MediaThumb, useResourceMediaUrl } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { WorkflowShotAudioEditor } from "./workflow-shot-audio";
import "./workflow-shot-media.css";

type Props = {
    open: boolean;
    projectId: string;
    shot?: DramaShot;
    onClose: () => void;
    onChanged?: () => void;
    presentation?: "dialog" | "page";
    shots?: DramaShot[];
    segmentLabel?: string;
    initialKind?: DramaShotMediaKind;
    onSelectShot?: (shot: DramaShot, kind: DramaShotMediaKind) => void;
    onEditText?: () => void;
    onDirtyChange?: (dirty: boolean, busy?: boolean) => void;
};
type Quote = { preview: DramaShotMediaPreflight; request: DramaShotMediaAction; uncertain?: boolean };
type PickerRole = "reference" | "first" | "last";
type VisualMediaKind = Exclude<DramaShotMediaKind, "audio">;

const STATE: Record<string, string> = { idle: "待生成", ready: "可使用", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", cancelled: "已取消", stale: "已有变更，请核对版本" };

function MediaPreview({ resourceId, kind }: { resourceId?: string; kind: VisualMediaKind }) {
    const url = useResourceMediaUrl(resourceId || "", kind === "video" ? "playback" : "original");
    if (!resourceId) return <p className="text-sm text-muted-foreground">还没有采用的{kind === "image" ? "镜头图片" : "镜头视频"}</p>;
    if (kind === "image") return <MediaThumb resourceId={resourceId} alt="当前镜头图片" />;
    return url ? <video controls src={url} preload="metadata" playsInline /> : <p role="status">正在读取视频…</p>;
}

export function WorkflowShotMediaDialog(props: Props) {
    const userId = useUserStore((state) => state.user?.id || "");
    return props.open && props.shot ? <ShotMediaSession key={`${userId}:${props.projectId}:${props.shot.id}`} {...props} shot={props.shot} userId={userId} /> : null;
}

function ShotMediaSession(props: Props & { shot: DramaShot; userId: string }) {
    const { modal } = App.useApp();
    const operation = useDramaOperationScope(props.projectId);
    const [kind, setKind] = useState<DramaShotMediaKind>(props.initialKind || "image");
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const editingState = useRef(props.onDirtyChange);
    editingState.current = props.onDirtyChange;
    useEffect(() => editingState.current?.(dirty, busy), [dirty, busy]);
    useEffect(() => () => editingState.current?.(false, false), []);
    const leave = (next: () => void) => {
        if (busy) return;
        if (!dirty) return next();
        const ticket = operation.capture();
        modal.confirm({
            title: "放弃未保存的镜头配置？",
            content: "已保存的媒体和任务会保留。",
            okText: "放弃修改",
            cancelText: "继续编辑",
            onOk: () => {
                if (operation.isCurrent(ticket)) next();
            },
        });
    };
    const tabs = (
        <nav className="drama-shot-media-tabs" aria-label="镜头媒体类型">
            {(["image", "video", "audio"] as const).map((value) => (
                <Button
                    key={value}
                    aria-pressed={kind === value}
                    disabled={busy}
                    onClick={() =>
                        kind !== value &&
                        leave(() => {
                            setDirty(false);
                            setKind(value);
                        })
                    }
                >
                    {value === "image" ? "镜头图片" : value === "video" ? "镜头视频" : "镜头音频"}
                </Button>
            ))}
        </nav>
    );
    const segmentShots = props.shots?.filter((shot) => shot.episodeId === props.shot.episodeId && shot.segmentIndex === props.shot.segmentIndex) || [];
    const segmentLabel = props.segmentLabel || `第 ${props.shot.segmentIndex + 1} 段`;
    const shotStrip =
        segmentShots.length && props.onSelectShot ? (
            <footer className="drama-shot-media-strip">
                <strong>
                    {segmentLabel} · 共 {segmentShots.length} 镜
                </strong>
                <nav aria-label="本段镜头" className="thin-scrollbar">
                    {segmentShots.map((shot) => (
                        <ShotStripItem
                            key={shot.id}
                            shot={shot}
                            active={shot.id === props.shot.id}
                            disabled={busy}
                            userId={props.userId}
                            onClick={() => {
                                if (shot.id !== props.shot.id) leave(() => props.onSelectShot?.(shot, kind));
                            }}
                        />
                    ))}
                </nav>
            </footer>
        ) : null;
    const content = (
        <div className={`drama-root drama-shot-media ${props.presentation === "page" ? "is-page" : "is-dialog"}`}>
            {props.presentation === "page" ? (
                <header className="drama-shot-media-header">
                    <Button disabled={busy} onClick={() => leave(props.onClose)}>
                        返回分镜
                    </Button>
                    <div>
                        <h3>
                            {segmentLabel} <span>分镜 {props.shot.position + 1}</span>
                        </h3>
                        <p>
                            {props.shot.scene || "未命名场景"} · {(props.shot.durationMs / 1000).toFixed(1)} 秒
                        </p>
                    </div>
                    {props.onEditText ? (
                        <Button disabled={busy} onClick={() => leave(props.onEditText!)}>
                            编辑分镜文字
                        </Button>
                    ) : null}
                </header>
            ) : null}
            {kind === "audio" ? (
                <WorkflowShotAudioEditor {...props} tabs={tabs} shotStrip={shotStrip} onDirtyChange={setDirty} onBusyChange={setBusy} />
            ) : (
                <ShotMediaEditor key={kind} {...props} tabs={tabs} shotStrip={shotStrip} kind={kind} onDirtyChange={setDirty} onBusyChange={setBusy} />
            )}
        </div>
    );
    return props.presentation === "page" ? (
        content
    ) : (
        <AppModal open centered width={1380} flush title={`镜头 ${props.shot.position + 1} · 图片、视频与音频`} footer={null} onCancel={() => leave(props.onClose)} maskClosable={!busy} closable={!busy}>
            {content}
        </AppModal>
    );
}

function ShotStripItem({ shot, active, disabled, userId, onClick }: { shot: DramaShot; active: boolean; disabled: boolean; userId: string; onClick: () => void }) {
    const image = useQuery({ queryKey: ["drama-shot-media", userId, shot.projectId, shot.id, "image"], queryFn: ({ signal }) => getDramaShotMedia(shot.projectId, shot.id, "image", signal), staleTime: 20_000 });
    return (
        <button type="button" aria-label={`切换分镜 ${shot.position + 1}`} aria-pressed={active} disabled={disabled} onClick={onClick}>
            <span>{image.data?.resourceId ? <MediaThumb resourceId={image.data.resourceId} alt={`分镜 ${shot.position + 1}`} /> : <span>{shot.shotSize || "待生成画面"}</span>}</span>
            <strong>分镜 {shot.position + 1}</strong>
        </button>
    );
}

function ShotMediaEditor({
    projectId,
    shot,
    userId,
    kind,
    onChanged,
    onDirtyChange,
    onBusyChange,
    tabs,
    shotStrip,
}: Props & { shot: DramaShot; userId: string; kind: VisualMediaKind; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; tabs: ReactNode; shotStrip: ReactNode }) {
    const client = useQueryClient();
    const operation = useDramaOperationScope(projectId);
    const catalog = useDramaModelCatalog();
    const queryKey = ["drama-shot-media", userId, projectId, shot.id, kind];
    const query = useQuery({ queryKey, queryFn: ({ signal }) => getDramaShotMedia(projectId, shot.id, kind, signal), refetchInterval: (current) => (["queued", "running"].includes(current.state.data?.status || "") ? 3000 : false) });
    const [draft, setDraft] = useState<DramaShotMediaConfig>();
    const [baseline, setBaseline] = useState<{ config: string; revision: number }>();
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [quote, setQuote] = useState<Quote>();
    const [picker, setPicker] = useState<PickerRole>();
    const [previewTakeId, setPreviewTakeId] = useState("");
    const locked = useRef(false);
    const current = query.data;
    const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== baseline.config);
    const stale = Boolean(current && baseline && current.revision !== baseline.revision);
    const active = ["queued", "running"].includes(current?.status || "");
    const controlsDisabled = Boolean(busy || quote?.uncertain || active);

    useEffect(() => {
        onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);
    useEffect(() => {
        onBusyChange(Boolean(busy || quote?.uncertain));
    }, [busy, quote?.uncertain, onBusyChange]);
    useEffect(() => {
        if (current && !draft) {
            setDraft(current.config);
            setBaseline({ config: JSON.stringify(current.config), revision: current.revision });
        }
    }, [current, draft]);

    const patch = (value: Partial<DramaShotMediaConfig>) => {
        if (controlsDisabled) return;
        setDraft((previous) => (previous ? { ...previous, ...value } : previous));
        setQuote(undefined);
        setNotice("");
    };
    const accept = (value: DramaShotMedia) => {
        client.setQueryData(queryKey, value);
        setDraft(value.config);
        setBaseline({ config: JSON.stringify(value.config), revision: value.revision });
    };
    const run = async (name: string, action: (ticket: ReturnType<typeof operation.capture>) => Promise<void>) => {
        if (locked.current) return;
        locked.current = true;
        const ticket = operation.capture();
        setBusy(name);
        setError("");
        try {
            await action(ticket);
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "操作失败");
        } finally {
            locked.current = false;
            if (operation.isCurrent(ticket)) setBusy("");
        }
    };
    const save = async (ticket: ReturnType<typeof operation.capture>) => {
        if (!draft || !baseline || stale) throw new Error("镜头媒体配置已有更新，请先重新载入");
        const saved = await saveDramaShotMedia(projectId, shot.id, kind, { expectedRevision: baseline.revision, config: draft });
        if (operation.isCurrent(ticket)) accept(saved);
        return saved;
    };
    const check = () =>
        run("preflight", async (ticket) => {
            if (!current || !draft || !baseline || stale) throw new Error("请先载入最新镜头配置");
            const value = dirty || !current.id ? await save(ticket) : current;
            if (!operation.isCurrent(ticket)) return;
            const preview = await preflightDramaShotMedia(projectId, shot.id, kind, { expectedRevision: value.revision });
            if (operation.isCurrent(ticket)) setQuote({ preview, request: { expectedRevision: preview.revision, baseRevision: preview.baseRevision, confirmationToken: preview.confirmationToken, clientOperationId: `shot-media:${crypto.randomUUID()}` } });
        });
    const execute = () =>
        run("execute", async (ticket) => {
            if (!quote?.preview.ready || !quote.preview.priced || !quote.preview.confirmationToken) return;
            try {
                const task = await executeDramaShotMedia(projectId, shot.id, kind, quote.request);
                if (!operation.isCurrent(ticket)) return;
                setNotice(`已提交镜头${kind === "image" ? "图片" : "视频"}，${STATE[task.status] || task.stage || "请查看任务进度"}`);
                setQuote(undefined);
            } catch (reason) {
                const rejected = reason instanceof ApiError && [reason.status, reason.code].some((value) => value !== undefined && value >= 400 && value < 500 && value !== 408);
                if (operation.isCurrent(ticket)) setQuote((previous) => (rejected ? undefined : previous ? { ...previous, uncertain: true } : previous));
                throw reason;
            }
            try {
                const updated = await getDramaShotMedia(projectId, shot.id, kind);
                if (!operation.isCurrent(ticket)) return;
                accept(updated);
                onChanged?.();
            } catch {
                if (operation.isCurrent(ticket)) setError("任务已提交，最新进度暂未刷新，请稍后重新载入");
            }
        });
    const options = catalog.data?.options[kind] || [];
    const model = draft ? options.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(draft.model)) : undefined;
    const ratios = kind === "image" ? model?.imageRatios : model?.videoRatios;
    const resolutions = kind === "image" ? model?.imageResolutions : model?.videoResolutions;
    const isVideo = kind === "video";
    const previewTake = current?.takes.find((take) => take.id === previewTakeId);

    if (query.isError && !current)
        return (
            <div className="drama-shot-media-loading" role="alert">
                {tabs}
                读取镜头媒体失败 <Button onClick={() => void query.refetch()}>重试</Button>
            </div>
        );
    if (query.isPending || !draft || !baseline)
        return (
            <div className="drama-shot-media-loading">
                {tabs}
                <p role="status">正在读取镜头媒体…</p>
            </div>
        );

    return (
        <>
            <div className="drama-shot-media-columns">
                <section className="drama-shot-media-config" aria-label="镜头生成配置">
                    {tabs}
                    <div className="drama-shot-media-operation" role="group" aria-label="镜头生成模式">
                        {(isVideo
                            ? ([
                                  { value: "text_to_video", label: "文生视频" },
                                  { value: "reference_to_video", label: "参考生视频" },
                                  { value: "image_to_video", label: "首尾帧" },
                              ] as const)
                            : ([
                                  { value: "text_to_image", label: "文生图" },
                                  { value: "image_to_image", label: "参考生图" },
                              ] as const)
                        ).map((option) => (
                            <button key={option.value} type="button" disabled={controlsDisabled} aria-pressed={draft.operation === option.value} onClick={() => patch({ operation: option.value })}>
                                {option.label}
                            </button>
                        ))}
                    </div>
                    <label>
                        <span>模型</span>
                        <fieldset disabled={controlsDisabled} className="drama-shot-media-model" inert={controlsDisabled}>
                            <DramaModelPicker capability={kind} value={draft.model} aspectRatio={draft.aspectRatio} onChange={(value) => patch({ model: value })} />
                        </fieldset>
                    </label>
                    <div className="drama-shot-media-parameters">
                        <label>
                            <span>画幅</span>
                            <Select
                                aria-label="镜头画幅"
                                disabled={controlsDisabled}
                                value={draft.aspectRatio}
                                options={[...new Set([draft.aspectRatio, ...(ratios || ["16:9", "9:16", "1:1"])])].filter(Boolean).map((value) => ({ value, label: value }))}
                                onChange={(value) => patch({ aspectRatio: value })}
                            />
                        </label>
                        <label>
                            <span>分辨率</span>
                            <Input aria-label="镜头分辨率" disabled={controlsDisabled} value={draft.resolution} list={`shot-resolutions-${kind}`} onChange={(event) => patch({ resolution: event.target.value })} />
                            <datalist id={`shot-resolutions-${kind}`}>
                                {resolutions?.map((value) => (
                                    <option key={value} value={value} />
                                ))}
                            </datalist>
                        </label>
                        {isVideo ? (
                            <label>
                                <span>秒数</span>
                                <InputNumber aria-label="镜头视频秒数" disabled={controlsDisabled} min={1} max={model?.maxVideoSeconds || 60} value={draft.seconds} onChange={(value) => patch({ seconds: value || 1 })} />
                            </label>
                        ) : null}
                    </div>
                    {isVideo ? (
                        <label>
                            <span>运镜意图</span>
                            <Select
                                aria-label="添加镜头运镜意图"
                                placeholder={shot.camera || "选择运镜，写入本次提示词"}
                                value={undefined}
                                disabled={controlsDisabled}
                                options={CAMERA_PRESETS.map((value) => ({ value, label: value }))}
                                onChange={(value) => patch({ prompt: `${draft.prompt.replace(/\n?【运镜意图】[^\n]*/g, "").trim()}\n【运镜意图】${value}`.trim() })}
                            />
                        </label>
                    ) : null}
                    {isVideo ? (
                        <label className="drama-shot-media-audio">
                            <span>同步生成声音</span>
                            <Switch disabled={controlsDisabled} checked={draft.generateAudio} onChange={(value) => patch({ generateAudio: value })} />
                        </label>
                    ) : null}
                    <div className="drama-shot-media-references">
                        <strong>参考图{isVideo ? "与首尾帧" : ""}</strong>
                        <div className="drama-shot-media-reference-row">
                            {draft.referenceResourceIds.map((id) => (
                                <ReferenceImage key={id} id={id} label="参考图" disabled={controlsDisabled} onRemove={() => patch({ referenceResourceIds: draft.referenceResourceIds.filter((value) => value !== id) })} />
                            ))}
                            <Button disabled={controlsDisabled} icon={<ImagePlus className="size-4" />} onClick={() => setPicker("reference")}>
                                添加参考图
                            </Button>
                        </div>
                        {isVideo ? (
                            <div className="drama-shot-media-reference-row">
                                {(["first", "last"] as const).map((role) => {
                                    const key = role === "first" ? "firstFrameResourceId" : "lastFrameResourceId";
                                    const label = role === "first" ? "首帧" : "尾帧";
                                    return draft[key] ? (
                                        <ReferenceImage key={role} id={draft[key]} label={label} disabled={controlsDisabled} onRemove={() => patch({ [key]: "" })} />
                                    ) : (
                                        <Button key={role} disabled={controlsDisabled} onClick={() => setPicker(role)}>
                                            选择{label}
                                        </Button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                    <label className="drama-shot-media-prompt">
                        <span>提示词</span>
                        <Input.TextArea aria-label="镜头媒体提示词" disabled={controlsDisabled} value={draft.prompt} autoSize={{ minRows: 4, maxRows: 7 }} onChange={(event) => patch({ prompt: event.target.value })} />
                    </label>
                    {stale ? <p role="status">镜头媒体有新版本，未保存的配置已保留。重新载入后再操作。</p> : null}
                    {error ? <p role="alert">{error}</p> : null}
                    {notice ? <p role="status">{notice}</p> : null}
                    <div className="drama-shot-media-actions">
                        <Button
                            disabled={controlsDisabled || stale || (!dirty && Boolean(current?.id))}
                            loading={busy === "save"}
                            onClick={() =>
                                void run("save", async (ticket) => {
                                    await save(ticket);
                                    if (operation.isCurrent(ticket)) setNotice("镜头配置已保存");
                                })
                            }
                        >
                            保存配置
                        </Button>
                        <Button
                            icon={<RefreshCw className="size-3.5" />}
                            disabled={Boolean(busy) || quote?.uncertain}
                            onClick={() =>
                                void run("reload", async (ticket) => {
                                    if (dirty) throw new Error("请先保存配置，或关闭后放弃修改再载入");
                                    const value = await getDramaShotMedia(projectId, shot.id, kind);
                                    if (operation.isCurrent(ticket)) {
                                        accept(value);
                                        setQuote(undefined);
                                    }
                                })
                            }
                        >
                            重新载入
                        </Button>
                        <Button className="drama-shot-media-generate" type="primary" disabled={controlsDisabled || stale || active} loading={busy === "preflight"} onClick={() => void check()}>
                            预检生成
                        </Button>
                    </div>
                    {quote ? (
                        <div className="drama-shot-media-quote" aria-live="polite">
                            <p>
                                {quote.preview.reason || `仅生成当前镜头${isVideo ? "视频" : "图片"}`} · {quote.preview.priced ? `${quote.preview.estimated ? "预估" : "预计"} ${formatDramaCredits(quote.preview.amountMicrocredits)} 积分` : "暂无法报价"}
                            </p>
                            {quote.uncertain ? <p>提交回执未确认，核对会复用同一次提交标识。</p> : null}
                            <Button type="primary" disabled={Boolean(busy) || !quote.preview.ready || !quote.preview.priced || (stale && !quote.uncertain)} loading={busy === "execute"} onClick={() => void execute()}>
                                {quote.uncertain ? "核对提交结果" : "确认生成当前镜头"}
                            </Button>
                        </div>
                    ) : null}
                </section>
                <section className="drama-shot-media-stage" aria-label="镜头媒体预览">
                    <header>
                        <strong>{previewTake ? `预览版本 ${previewTake.version}` : "当前采用"}</strong>
                        <span>{STATE[current?.status || "idle"] || current?.status}</span>
                    </header>
                    <div className="drama-shot-media-canvas">
                        <MediaPreview resourceId={previewTake?.resourceId || current?.resourceId} kind={kind} />
                    </div>
                    {active ? <p role="status">任务正在{current?.status === "queued" ? "排队" : "生成"}，完成后自动刷新。已有采用版本仍保留。</p> : null}
                    {current?.error ? <p role="alert">{current.error}</p> : null}
                    <p className="drama-shot-media-shot-copy">
                        {shot.action || shot.imagePrompt}
                        {shot.dialogue ? `\n${shot.speaker || "对白"}：${shot.dialogue}` : ""}
                    </p>
                    {previewTake ? (
                        <Button size="small" onClick={() => setPreviewTakeId("")}>
                            回到当前采用
                        </Button>
                    ) : null}
                    {shotStrip}
                </section>
                <aside className="drama-shot-media-output" aria-label="镜头媒体结果与版本">
                    <header>
                        <strong>版本记录</strong>
                        <span>{current?.takes.length || 0} 个版本</span>
                    </header>
                    {current?.takes.length ? (
                        current.takes.map((take) => (
                            <div className={`drama-shot-media-take ${take.current ? "is-current" : ""}`} key={take.id}>
                                <span>
                                    版本 {take.version} · {take.current ? "当前采用" : STATE[take.status] || take.status}
                                </span>
                                {take.resourceId ? <MediaPreview resourceId={take.resourceId} kind={kind} /> : null}
                                {take.error ? <p>{take.error}</p> : null}
                                {take.resourceId ? (
                                    <Button size="small" aria-pressed={previewTakeId === take.id} onClick={() => setPreviewTakeId(take.id)}>
                                        查看此版本
                                    </Button>
                                ) : null}
                                {!take.current && take.resourceId ? (
                                    <Button
                                        size="small"
                                        disabled={Boolean(busy) || dirty || stale || quote?.uncertain}
                                        onClick={() =>
                                            void run("adopt", async (ticket) => {
                                                if (!current) return;
                                                const adopted = await adoptDramaShotMedia(projectId, shot.id, kind, { expectedRevision: current.revision, takeId: take.id });
                                                if (operation.isCurrent(ticket)) {
                                                    accept(adopted);
                                                    setPreviewTakeId("");
                                                    setQuote(undefined);
                                                    onChanged?.();
                                                }
                                            })
                                        }
                                    >
                                        采用此版本
                                    </Button>
                                ) : null}
                            </div>
                        ))
                    ) : (
                        <p className="text-sm text-muted-foreground">生成后会记录真实任务和媒体版本</p>
                    )}
                </aside>
            </div>
            <AssetLibraryPickerModal
                open={Boolean(picker)}
                remoteLibrary
                acceptRemoteItems
                remoteKind="image"
                mediaKinds={["image"]}
                multiple={false}
                items={[]}
                categoryLabels={{ all: "全部素材" }}
                title={picker === "first" ? "选择首帧" : picker === "last" ? "选择尾帧" : "选择参考图"}
                onClose={() => setPicker(undefined)}
                remoteItemDisabledReason={(asset) => (asset.kind === "image" && resourceIdFromStorageKey(asset.data.storageKey) ? undefined : "请选择已保存的图片")}
                onConfirm={(_ids, items) => {
                    const asset = items?.[0]?.asset;
                    const id = asset?.kind === "image" ? resourceIdFromStorageKey(asset.data.storageKey) : "";
                    if (!id) throw new Error("图片还没有保存到服务器");
                    if (picker === "first") patch({ firstFrameResourceId: id, operation: "image_to_video" });
                    else if (picker === "last") patch({ lastFrameResourceId: id, operation: "image_to_video" });
                    else
                        patch({ referenceResourceIds: [...new Set([...draft.referenceResourceIds, id])], operation: kind === "image" ? "image_to_image" : draft.firstFrameResourceId || draft.lastFrameResourceId ? "image_to_video" : "reference_to_video" });
                    setPicker(undefined);
                }}
            />
        </>
    );
}

function ReferenceImage({ id, label, disabled, onRemove }: { id: string; label: string; disabled: boolean; onRemove: () => void }) {
    return (
        <div className="drama-shot-media-reference">
            <MediaThumb resourceId={id} alt={label} />
            <span>{label}</span>
            <Button size="small" aria-label={`移除${label}`} disabled={disabled} icon={<Trash2 className="size-3" />} onClick={onRemove} />
        </div>
    );
}
