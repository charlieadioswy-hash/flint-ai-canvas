import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Select, Switch } from "antd";
import { RefreshCw } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { dramaChoiceKey } from "@/lib/drama/model-choice";
import { CAMERA_PRESETS } from "@/lib/drama/director";
import type { DramaShot } from "@/services/api/drama";
import {
    adoptDramaShotMedia,
    executeDramaShotMedia,
    getDramaShotMedia,
    preflightDramaShotMedia,
    quoteDramaShotMedia,
    saveDramaShotMedia,
    type DramaShotMedia,
    type DramaShotMediaAction,
    type DramaShotMediaConfig,
    type DramaShotMediaKind,
    type DramaShotMediaPreflight,
} from "@/services/api/drama-shot-media";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { MediaThumb, useResourceMediaUrl } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { WorkflowShotAudioEditor } from "./workflow-shot-audio";
import { WorkflowShotReferences } from "./workflow-shot-references";
import { WorkflowShotPromptEditor } from "./workflow-shot-prompt";
import { preserveShotImageMentions } from "./workflow-shot-reference-bindings";
import { generationLabel } from "./workflow-generation";
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
    onDirtyChange?: (dirty: boolean, busy?: boolean, automatic?: boolean) => void;
};
type Quote = { preview: DramaShotMediaPreflight; request: DramaShotMediaAction; uncertain?: boolean };
type VisualMediaKind = Exclude<DramaShotMediaKind, "audio">;

const STATE: Record<string, string> = { idle: "待生成", ready: "可使用", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", cancelled: "已取消", stale: "已有变更，请核对版本" };

function visibleReferenceConfig(config: DramaShotMediaConfig, kind: VisualMediaKind): DramaShotMediaConfig {
    if (kind === "video" && config.operation === "image_to_video") return config.referenceResourceIds.length ? { ...config, ...preserveShotImageMentions(config, { referenceResourceIds: [] }, kind) } : config;
    return config.firstFrameResourceId || config.lastFrameResourceId ? { ...config, firstFrameResourceId: "", lastFrameResourceId: "" } : config;
}

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
    const [automaticBusy, setAutomaticBusy] = useState(false);
    const mediaBusyChanged = useCallback((busy: boolean, automatic = false) => {
        setBusy(busy);
        setAutomaticBusy(automatic);
    }, []);
    const [syncBlocked, setSyncBlocked] = useState(false);
    const flushVisualConfig = useRef<(() => Promise<boolean>) | undefined>(undefined);
    const leaving = useRef(false);
    const editingState = useRef(props.onDirtyChange);
    editingState.current = props.onDirtyChange;
    useEffect(() => editingState.current?.(kind === "audio" ? dirty : dirty && syncBlocked, busy || (kind !== "audio" && dirty && !syncBlocked), kind !== "audio" && (!busy || automaticBusy)), [dirty, busy, automaticBusy, kind, syncBlocked]);
    useEffect(() => () => editingState.current?.(false, false), []);
    const leave = async (next: () => void) => {
        if (busy || leaving.current) return;
        if (!dirty) return next();
        leaving.current = true;
        const ticket = operation.capture();
        if (kind !== "audio" && (await flushVisualConfig.current?.())) {
            if (operation.isCurrent(ticket)) next();
            leaving.current = false;
            return;
        }
        if (!operation.isCurrent(ticket)) {
            leaving.current = false;
            return;
        }
        modal.confirm({
            title: "放弃未保存的镜头配置？",
            content: "已保存的媒体和任务会保留。",
            okText: "放弃修改",
            cancelText: "继续编辑",
            onOk: () => {
                leaving.current = false;
                if (operation.isCurrent(ticket)) next();
            },
            onCancel: () => {
                leaving.current = false;
            },
        });
    };
    const tabs = (
        <nav className="drama-shot-media-tabs" aria-label="镜头媒体类型">
            {(["image", "video", "audio"] as const).map((value) => (
                <button
                    type="button"
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
                    {value === "image" ? "图片" : value === "video" ? "视频" : "音频"}
                </button>
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
                <WorkflowShotAudioEditor {...props} tabs={tabs} shotStrip={shotStrip} onDirtyChange={setDirty} onBusyChange={mediaBusyChanged} />
            ) : (
                <ShotMediaEditor
                    key={kind}
                    {...props}
                    tabs={tabs}
                    shotStrip={shotStrip}
                    kind={kind}
                    onDirtyChange={setDirty}
                    onBusyChange={mediaBusyChanged}
                    onSyncBlockedChange={setSyncBlocked}
                    registerFlush={(flush) => (flushVisualConfig.current = flush)}
                />
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
    onSyncBlockedChange,
    registerFlush,
    tabs,
    shotStrip,
}: Props & {
    shot: DramaShot;
    userId: string;
    kind: VisualMediaKind;
    onDirtyChange: (dirty: boolean) => void;
    onBusyChange: (busy: boolean, automatic?: boolean) => void;
    onSyncBlockedChange: (blocked: boolean) => void;
    registerFlush: (flush?: () => Promise<boolean>) => void;
    tabs: ReactNode;
    shotStrip: ReactNode;
}) {
    const client = useQueryClient();
    const operation = useDramaOperationScope(projectId);
    const catalog = useDramaModelCatalog();
    const queryKey = ["drama-shot-media", userId, projectId, shot.id, kind];
    const query = useQuery({ queryKey, queryFn: ({ signal }) => getDramaShotMedia(projectId, shot.id, kind, signal), refetchInterval: (current) => (["queued", "running"].includes(current.state.data?.status || "") ? 3000 : false) });
    const [draft, setDraft] = useState<DramaShotMediaConfig>();
    const [baseline, setBaseline] = useState<{ config: string; revision: number }>();
    const [busy, setBusy] = useState("");
    const [saving, setSaving] = useState(false);
    const [syncFailed, setSyncFailed] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [quote, setQuote] = useState<Quote>();
    const [price, setPrice] = useState<{ key: string; version: number; preview: DramaShotMediaPreflight }>();
    const [priceError, setPriceError] = useState<{ key: string; message: string }>();
    const [pricing, setPricing] = useState("");
    const [priceVersion, setPriceVersion] = useState(0);
    const [referenceBusy, setReferenceBusy] = useState(false);
    const [previewTakeId, setPreviewTakeId] = useState("");
    const locked = useRef(false);
    const current = query.data;
    const editor = useRef({ draft, baseline, current });
    editor.current = { draft, baseline, current };
    const savingRequest = useRef<Promise<DramaShotMedia> | undefined>(undefined);
    const failedDraft = useRef("");
    const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== baseline.config);
    const stale = Boolean(current && baseline && current.revision !== baseline.revision);
    const active = ["queued", "running"].includes(current?.status || "");
    const configLocked = Boolean(busy || quote?.uncertain || active);
    const controlsDisabled = configLocked || referenceBusy;
    const priceKey = (config: DramaShotMediaConfig, revision: number) => JSON.stringify([config, revision, shot]);
    const draftKey = draft && baseline ? priceKey(draft, baseline.revision) : "";
    const displayedPrice = price?.key === draftKey && !stale ? price.preview : undefined;
    const acceptPreviewConfig = (preview: DramaShotMediaPreflight, config: DramaShotMediaConfig, revision: number) => {
        const snapshot = editor.current;
        const key = JSON.stringify(config);
        if (savingRequest.current || preview.revision !== revision || snapshot.baseline?.revision !== revision || snapshot.current?.revision !== revision || JSON.stringify(snapshot.draft) !== key) return;
        const canonical = JSON.stringify(preview.config);
        if (canonical !== key) {
            // A read-only quote may refresh automatic text without making a clean
            // editor dirty. Existing local edits must still reach autosave.
            const clean = snapshot.baseline.config === key;
            const nextBaseline = clean ? { config: canonical, revision } : snapshot.baseline;
            const nextCurrent = clean ? { ...snapshot.current, config: preview.config } : snapshot.current;
            editor.current = { draft: preview.config, baseline: nextBaseline, current: nextCurrent };
            setDraft(preview.config);
            if (clean) {
                setBaseline(nextBaseline);
                client.setQueryData(queryKey, nextCurrent);
            }
        }
        return preview.config;
    };

    useEffect(() => {
        if (!draft || !baseline || stale || active || busy || saving || quote?.uncertain || (price?.key === draftKey && price.version === priceVersion)) return;
        let cancelled = false;
        const controller = new AbortController();
        const ticket = operation.capture();
        setPricing(draftKey);
        const timer = window.setTimeout(() => {
            void quoteDramaShotMedia(projectId, shot.id, kind, { expectedRevision: baseline.revision, config: draft }, controller.signal)
                .then((preview) => {
                    if (!cancelled && operation.isCurrent(ticket)) {
                        const config = acceptPreviewConfig(preview, draft, baseline.revision);
                        if (!config) return;
                        setPrice({ key: priceKey(config, baseline.revision), version: priceVersion, preview });
                        setPriceError(undefined);
                    }
                })
                .catch((reason) => {
                    if (!cancelled && operation.isCurrent(ticket)) {
                        setPrice(undefined);
                        setPriceError({ key: draftKey, message: reason instanceof Error ? reason.message : "暂无法取得报价" });
                    }
                })
                .finally(() => {
                    if (!cancelled && operation.isCurrent(ticket)) setPricing("");
                });
        }, 300);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [draftKey, stale, active, busy, saving, quote?.uncertain, priceVersion]);

    useEffect(() => {
        onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);
    useEffect(() => {
        onBusyChange(Boolean(busy || saving || quote?.uncertain || referenceBusy), Boolean(saving && !busy && !quote?.uncertain && !referenceBusy));
    }, [busy, saving, quote?.uncertain, referenceBusy, onBusyChange]);
    useEffect(() => onSyncBlockedChange(syncFailed || stale), [syncFailed, stale, onSyncBlockedChange]);
    useEffect(() => {
        if (current && !draft) {
            setDraft(visibleReferenceConfig(current.config, kind));
            setBaseline({ config: JSON.stringify(current.config), revision: current.revision });
        }
    }, [current, draft, kind]);

    const patch = (value: Partial<DramaShotMediaConfig>) => {
        if (configLocked) return;
        const current = editor.current.draft;
        const next = current ? { ...current, ...preserveShotImageMentions(current, value, kind) } : undefined;
        editor.current.draft = next;
        setDraft(next);
        failedDraft.current = "";
        setSyncFailed(false);
        setError("");
        setQuote(undefined);
        setNotice("");
    };
    const accept = (value: DramaShotMedia) => {
        const config = visibleReferenceConfig(value.config, kind);
        editor.current = { draft: config, baseline: { config: JSON.stringify(value.config), revision: value.revision }, current: value };
        client.setQueryData(queryKey, value);
        setDraft(config);
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
    const save = (ticket: ReturnType<typeof operation.capture>, create = false): Promise<DramaShotMedia> => {
        if (savingRequest.current) return savingRequest.current.then(() => save(ticket, create));
        const request = (async () => {
            while (operation.isCurrent(ticket)) {
                const snapshot = editor.current;
                if (!snapshot.draft || !snapshot.baseline || !snapshot.current || snapshot.current.revision !== snapshot.baseline.revision) throw new Error("镜头媒体配置已有更新，请先重新载入");
                const key = JSON.stringify(snapshot.draft);
                if (key === snapshot.baseline.config && (snapshot.current.id || !create)) return snapshot.current;
                const saved = await saveDramaShotMedia(projectId, shot.id, kind, { expectedRevision: snapshot.baseline.revision, config: snapshot.draft });
                if (!operation.isCurrent(ticket)) return saved;
                const latest = editor.current.draft;
                const stillSame = JSON.stringify(latest) === key;
                const nextBaseline = { config: JSON.stringify(saved.config), revision: saved.revision };
                editor.current = { draft: stillSame ? saved.config : latest, baseline: nextBaseline, current: saved };
                client.setQueryData(queryKey, saved);
                setBaseline(nextBaseline);
                if (stillSame) setDraft(saved.config);
                failedDraft.current = "";
                setSyncFailed(false);
            }
            throw new Error("当前镜头已切换");
        })();
        setError("");
        setSaving(true);
        const pending = request
            .catch((reason) => {
                if (operation.isCurrent(ticket)) {
                    failedDraft.current = JSON.stringify(editor.current.draft);
                    setSyncFailed(true);
                    setError(`配置未同步：${reason instanceof Error ? reason.message : "请重试"}`);
                }
                throw reason;
            })
            .finally(() => {
                if (savingRequest.current === pending) savingRequest.current = undefined;
                if (operation.isCurrent(ticket)) setSaving(false);
            });
        savingRequest.current = pending;
        return pending;
    };
    const saveLatest = useRef(save);
    saveLatest.current = save;
    useEffect(() => {
        registerFlush(async () => {
            try {
                await saveLatest.current(operation.capture());
                return true;
            } catch {
                return false;
            }
        });
        return () => registerFlush(undefined);
    }, [registerFlush, operation.capture]);
    useEffect(() => {
        if (!dirty || stale || active || busy || quote?.uncertain || failedDraft.current === JSON.stringify(draft)) return;
        const timer = window.setTimeout(() => void saveLatest.current(operation.capture()).catch(() => undefined), 300);
        return () => window.clearTimeout(timer);
    }, [draft, baseline?.revision, dirty, stale, active, busy, quote?.uncertain, operation.capture]);
    const execute = () =>
        run("execute", async (ticket) => {
            let submission = quote?.uncertain ? quote : undefined;
            if (!submission) {
                if (!current || !draft || !baseline || stale || active || !displayedPrice?.ready || !displayedPrice.priced || !displayedPrice.scopeHash) return;
                const value = await save(ticket, true);
                if (!operation.isCurrent(ticket)) return;
                const preview = await preflightDramaShotMedia(projectId, shot.id, kind, { expectedRevision: value.revision });
                if (!operation.isCurrent(ticket)) return;
                const config = acceptPreviewConfig(preview, value.config, value.revision);
                if (!config) return;
                setPrice({ key: priceKey(config, value.revision), version: priceVersion, preview });
                if (!preview.ready || !preview.priced || !preview.confirmationToken || preview.scopeHash !== displayedPrice.scopeHash || preview.amountMicrocredits !== displayedPrice.amountMicrocredits) {
                    setNotice("费用或生成范围已更新，请查看生成按钮后再操作。当前配置已保存。");
                    return;
                }
                submission = { preview, request: { expectedRevision: preview.revision, baseRevision: preview.baseRevision, confirmationToken: preview.confirmationToken, clientOperationId: `shot-media:${crypto.randomUUID()}` } };
                setQuote(submission);
            }
            try {
                const task = await executeDramaShotMedia(projectId, shot.id, kind, submission.request);
                if (!operation.isCurrent(ticket)) return;
                setNotice(`已提交镜头${kind === "image" ? "图片" : "视频"}，${STATE[task.status] || task.stage || "请查看任务进度"}`);
                setQuote(undefined);
                setPrice(undefined);
                client.setQueryData(queryKey, { ...editor.current.current, status: task.status, taskId: task.id });
            } catch (reason) {
                const rejected = reason instanceof ApiError && [reason.status, reason.code].some((value) => value !== undefined && value >= 400 && value < 500 && value !== 408);
                if (operation.isCurrent(ticket)) {
                    setQuote(rejected ? undefined : { ...submission, uncertain: true });
                    if (rejected) {
                        setPrice(undefined);
                        setPriceVersion((value) => value + 1);
                    }
                }
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
                            <button
                                key={option.value}
                                type="button"
                                disabled={controlsDisabled}
                                aria-pressed={draft.operation === option.value}
                                onClick={() => {
                                    if (draft.operation === option.value) return;
                                    patch({
                                        operation: option.value,
                                        ...(option.value === "image_to_video" ? { referenceResourceIds: [] } : { firstFrameResourceId: "", lastFrameResourceId: "" }),
                                        ...(["text_to_image", "text_to_video"].includes(option.value) ? { referenceResourceIds: [] } : {}),
                                    });
                                }}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                    <label>
                        <span>模型</span>
                        <fieldset disabled={controlsDisabled} className="drama-shot-media-model" inert={controlsDisabled}>
                            <DramaModelPicker capability={kind} showPrice={false} value={draft.model} aspectRatio={draft.aspectRatio} onChange={(value) => patch({ model: value })} />
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
                    <WorkflowShotReferences projectId={projectId} userId={userId} kind={kind} config={draft} disabled={configLocked} onChange={patch} onBusyChange={setReferenceBusy} />
                    <WorkflowShotPromptEditor projectId={projectId} userId={userId} shot={shot} kind={kind} config={draft} disabled={controlsDisabled} onChange={patch} />
                    {stale ? <p role="status">镜头媒体有新版本，未保存的配置已保留。重新载入后再操作。</p> : null}
                    {error ? <p role="alert">{error}</p> : null}
                    {notice ? <p role="status">{notice}</p> : null}
                    <div className="drama-shot-media-actions">
                        {syncFailed && !stale ? (
                            <Button disabled={controlsDisabled || saving} onClick={() => void save(operation.capture()).catch(() => undefined)}>
                                重新同步配置
                            </Button>
                        ) : null}
                        <Button
                            icon={<RefreshCw className="size-3.5" />}
                            disabled={Boolean(busy) || saving || quote?.uncertain || referenceBusy}
                            onClick={() =>
                                void run("reload", async (ticket) => {
                                    if (dirty && !stale) await save(ticket);
                                    if (dirty && stale) throw new Error("镜头媒体已有新版本，请关闭后放弃本地修改再重新进入");
                                    const value = await getDramaShotMedia(projectId, shot.id, kind);
                                    if (operation.isCurrent(ticket)) {
                                        accept(value);
                                        setQuote(undefined);
                                        setPriceVersion((version) => version + 1);
                                    }
                                })
                            }
                        >
                            重新载入
                        </Button>
                        <Button
                            className="drama-shot-media-generate"
                            type="primary"
                            disabled={Boolean(busy) || saving || referenceBusy || (!quote?.uncertain && (stale || active || !displayedPrice?.ready || !displayedPrice.priced || !displayedPrice.scopeHash || pricing === draftKey))}
                            loading={busy === "execute"}
                            onClick={() => void execute()}
                        >
                            {quote?.uncertain ? "核对提交结果" : generationLabel(isVideo ? "生成视频" : "生成图片", displayedPrice, !active && pricing === draftKey)}
                        </Button>
                    </div>
                    {saving ? <p role="status">正在同步配置…</p> : null}
                    {quote?.uncertain ? <p role="status">提交回执未确认，核对会复用同一次提交标识。</p> : null}
                    {!active && displayedPrice && (!displayedPrice.ready || !displayedPrice.priced) ? <p role="status">{displayedPrice.reason || "当前参数暂无法取得报价，请调整配置。"}</p> : null}
                    {priceError?.key === draftKey ? <p role="alert">{priceError.message}</p> : null}
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
                                        disabled={Boolean(busy) || saving || referenceBusy || dirty || stale || quote?.uncertain}
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
        </>
    );
}
