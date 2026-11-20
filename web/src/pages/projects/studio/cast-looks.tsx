import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Input, InputNumber } from "antd";
import { AlertCircle, Check, Pencil, Plus, Shirt, Trash2, X, Play, Upload, Library } from "lucide-react";

import { addDramaCastLook, deleteDramaCastLook, updateDramaCastLook, setDramaCastImage, updateDramaCast, listDramaCast, getDrama, type DramaCast, type DramaCastImageStyle, type DramaSettings } from "@/services/api/drama";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { ApiError } from "@/services/api/request";
import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import { CastImageFields, type CastImageFieldsValue } from "./cast-image-fields";
import { uploadResourceFile } from "@/services/api/resources";
import { CastLibraryPicker } from "./cast-library-picker";
import { CastImageNotSubmittedError, useCastImageQuote } from "./use-cast-image-quote";
import { useDramaOperationScope } from "./use-drama-operation-scope";
import { generationLabel } from "../workflow-generation";

import { mediaBusy, MediaThumb } from "../drama-shared";

const MAX_LOOKS = 6;
type LookInput = DramaCastImageStyle & { lookName: string; appearance: string; imagePrompt: string; fromChapter?: number; toChapter?: number };
type ImageQuote = NonNullable<ReturnType<typeof useCastImageQuote>["data"]>;
type LookGeneration = { look: DramaCast; accepted: ImageQuote; execute: (accepted: ImageQuote, restyleSegments?: boolean, isCurrent?: () => boolean) => Promise<{ affectedSegments?: number } | undefined>; isCurrent: () => boolean };

function chapterLabel(from?: number, to?: number) {
    if (from && to) return `第 ${from}–${to} 章`;
    if (from) return `第 ${from} 章起`;
    if (to) return `第 ${to} 章前`;
    return "不限章节";
}

function lookInputFromCast(look: DramaCast): LookInput {
    return {
        lookName: look.lookName || "",
        appearance: look.appearance,
        imagePrompt: look.imagePrompt || "",
        imageStyleId: look.imageStyleId || "",
        imageStyleName: look.imageStyleName || "",
        imageStylePrompt: look.imageStylePrompt || "",
        fromChapter: look.lookFromChapter || 0,
        toChapter: look.lookToChapter || 0,
    };
}

/** 一套造型的编辑表单（新增或修改共用）。 */
function LookForm({
    projectId,
    episodeId,
    dramaType,
    initial,
    restyleSegments = false,
    submitting = false,
    onCancel,
    onSubmit,
    onSaved,
    onDirtyChange,
}: {
    projectId: string;
    episodeId?: string;
    dramaType?: DramaSettings["dramaType"];
    initial?: DramaCast;
    restyleSegments?: boolean;
    submitting?: boolean;
    onCancel: () => void;
    onSubmit?: (value: LookInput) => void;
    onSaved?: () => void;
    onDirtyChange: (dirty: boolean, busy: boolean) => void;
}) {
    const [name, setName] = useState(initial?.lookName || "");
    const [appearance, setAppearance] = useState(initial?.appearance || "");
    const [imageFields, setImageFields] = useState<CastImageFieldsValue>({
        imagePrompt: initial?.imagePrompt || "",
        imageStyleId: initial?.imageStyleId || "",
        imageStyleName: initial?.imageStyleName || "",
        imageStylePrompt: initial?.imageStylePrompt || "",
    });
    const [from, setFrom] = useState<number | null>(initial?.lookFromChapter || null);
    const [to, setTo] = useState<number | null>(initial?.lookToChapter || null);
    const value: LookInput = { ...imageFields, lookName: name.trim(), appearance: appearance.trim(), imagePrompt: (imageFields.imagePrompt || "").trim(), fromChapter: from ?? 0, toChapter: to ?? 0 };
    const draftKey = JSON.stringify(value);
    const [savedKey, setSavedKey] = useState(draftKey);
    const savedValue = useRef(value);
    const baseline = useRef(initial);
    const operation = useDramaOperationScope(projectId);
    const summary = useQuery({ queryKey: dramaKeys.summary(projectId), queryFn: ({ signal }) => getDrama(projectId, signal), enabled: Boolean(initial) });
    const attempt = useRef("");
    const revision = useRef(initial?.revision);
    const inFlight = useRef(false);
    const [saveError, setSaveError] = useState("");
    const [refreshing, setRefreshing] = useState(false);
    const valid = Boolean(name.trim() && appearance.trim() && (!from || !to || from <= to));
    const dirty = savedKey !== draftKey;
    const versionError = initial && (summary.isError || (summary.data && typeof revision.current !== "number")) ? "作品或造型版本读取失败，请刷新状态后重试" : "";
    const saveIssue = saveError || versionError;
    const autoSave = useMutation({
        mutationFn: async ({ key, value, ticket }: { key: string; value: LookInput; ticket: ReturnType<typeof operation.capture> }) => {
            if (inFlight.current || !operation.isCurrent(ticket)) return;
            inFlight.current = true;
            let productionRevision = summary.data!.production.revision;
            let castRevision = revision.current;
            let currentBaseline = baseline.current!;
            const changed = (Object.keys(value) as Array<keyof LookInput>).filter((key) => value[key] !== savedValue.current[key]);
            const write = () => {
                const merged = lookInputFromCast(currentBaseline);
                for (const key of changed) Object.assign(merged, { [key]: value[key] });
                return updateDramaCastLook(projectId, initial!.id, { ...merged, restyleSegments, expectedRevision: productionRevision, expectedCastRevision: castRevision, ...(episodeId ? { episodeId } : {}) });
            };
            try {
                let result;
                try {
                    result = await write();
                } catch (error) {
                    if (!(error instanceof ApiError) || ![error.status, error.code].includes(409) || (error.reason && error.reason !== "conflict") || !operation.isCurrent(ticket)) throw error;
                    const [latestSummary, latestCast] = await Promise.all([getDrama(projectId), listDramaCast(projectId)]);
                    if (!operation.isCurrent(ticket)) return;
                    const current = latestCast.cast.find((item) => item.id === initial!.id);
                    if (
                        latestSummary.project.id !== projectId ||
                        !current ||
                        current.projectId !== projectId ||
                        current.parentId !== initial!.parentId ||
                        current.kind !== initial!.kind ||
                        mediaBusy(current.imageStatus) ||
                        typeof current.revision !== "number" ||
                        !(latestSummary.production.revision > productionRevision || current.revision > (castRevision ?? 0))
                    )
                        throw error;
                    productionRevision = latestSummary.production.revision;
                    castRevision = current.revision;
                    currentBaseline = current;
                    result = await write();
                }
                if (!operation.isCurrent(ticket)) return;
                revision.current = result.look.revision;
                baseline.current = result.look;
                savedValue.current = value;
                // 回执仅推进它实际保存的快照；保存期间的新输入继续排队。
                setSavedKey(key);
                setSaveError("");
                await summary.refetch();
                if (operation.isCurrent(ticket)) onSaved?.();
            } catch (error) {
                if (operation.isCurrent(ticket)) setSaveError(error instanceof Error ? error.message : "造型自动保存失败");
            } finally {
                inFlight.current = false;
            }
        },
    });
    const startSave = () => {
        if (!initial || !valid || !summary.data || typeof revision.current !== "number" || inFlight.current) return;
        attempt.current = draftKey;
        setSaveError("");
        autoSave.mutate({ key: draftKey, value, ticket: operation.capture() });
    };
    const refreshVersion = async () => {
        if (!initial || refreshing) return;
        const ticket = operation.capture();
        setRefreshing(true);
        try {
            const [latest, cast] = await Promise.all([summary.refetch(), listDramaCast(projectId)]);
            if (!operation.isCurrent(ticket)) return;
            const current = cast.cast.find((item) => item.id === initial.id);
            if (!latest.data || latest.isError || latest.data.project.id !== projectId || !current || current.projectId !== projectId || current.parentId !== initial.parentId || current.kind !== initial.kind || typeof current.revision !== "number")
                throw new Error("作品或造型版本读取失败，修改仍保留");
            revision.current = current.revision;
            baseline.current = current;
            attempt.current = "";
            setSaveError("");
        } catch (error) {
            if (operation.isCurrent(ticket)) setSaveError(error instanceof Error ? error.message : "状态读取失败");
        } finally {
            if (operation.isCurrent(ticket)) setRefreshing(false);
        }
    };
    const stateChange = useRef(onDirtyChange);
    stateChange.current = onDirtyChange;
    useEffect(() => {
        stateChange.current(dirty && (!initial || !valid || Boolean(saveIssue)), refreshing || autoSave.isPending || Boolean(initial && dirty && valid && !saveIssue));
    }, [dirty, initial, valid, saveIssue, autoSave.isPending, refreshing]);
    useEffect(() => () => stateChange.current(false, false), []);
    useEffect(() => {
        if (!initial || !valid || !summary.data || versionError || refreshing || submitting || autoSave.isPending || !dirty || attempt.current === draftKey) return;
        const timer = setTimeout(startSave, 350);
        return () => clearTimeout(timer);
    }, [initial, valid, summary.data, versionError, refreshing, submitting, autoSave.isPending, draftKey, dirty]);
    const close = () => {
        if (refreshing || autoSave.isPending || (initial && dirty && valid && !saveIssue)) return;
        onCancel();
    };
    return (
        <div className="drama-look-form">
            <Input value={name} maxLength={60} placeholder="造型名，如 外门弟子、霸道总裁" aria-label="造型名" onChange={(event) => setName(event.target.value)} />
            <Input.TextArea value={appearance} maxLength={1000} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="这套造型的服装、发型与妆容；五官脸型沿用角色本体" aria-label="造型外观" onChange={(event) => setAppearance(event.target.value)} />
            <CastImageFields
                projectId={projectId}
                episodeId={episodeId}
                dramaType={dramaType}
                castId={initial?.id}
                appearance={appearance}
                value={imageFields}
                disabled={submitting}
                onChange={(patch) => setImageFields((current) => ({ ...current, ...patch }))}
            />
            {saveIssue ? <p role="alert">自动保存失败：{saveIssue}。修改仍保留。</p> : null}
            {initial && dirty && !valid ? <p role="alert">请填写造型名和外观，并检查起止章节，修改仍保留。</p> : null}
            <small>以角色本体图保持人物一致。{initial ? "设定会自动保存，" : "确认只保存设定，"}点击“生成图片”才调用模型。</small>
            <div className="drama-look-form-range">
                <span>默认适用</span>
                <InputNumber size="small" min={0} precision={0} value={from} placeholder="起始章" aria-label="起始章" onChange={(value) => setFrom(value)} />
                <span>至</span>
                <InputNumber size="small" min={0} precision={0} value={to} placeholder="结束章" aria-label="结束章" onChange={(value) => setTo(value)} />
                <small>0 或留空表示该端不限；对应章节的分集默认用这套造型</small>
            </div>
            <div className="drama-look-form-actions">
                <Button size="small" icon={<X className="size-3.5" />} disabled={refreshing || autoSave.isPending || Boolean(initial && dirty && valid && !saveIssue)} onClick={close}>
                    {initial ? (dirty ? "放弃修改并关闭" : "关闭编辑") : "取消"}
                </Button>
                {initial && versionError ? (
                    <Button size="small" loading={refreshing} onClick={() => void refreshVersion()}>
                        刷新状态
                    </Button>
                ) : initial && saveError && valid ? (
                    <Button size="small" onClick={startSave}>
                        重试保存
                    </Button>
                ) : null}
                {!initial ? (
                    <Button size="small" type="primary" icon={<Check className="size-3.5" />} loading={submitting} disabled={!valid} onClick={() => onSubmit?.(value)}>
                        确认保存
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

/**
 * 角色造型（多妆造）：一个角色可有多套造型（如散修 / 外门弟子 / 内门弟子 / 长老），每套有自己的外观与参考图，
 * 以角色本体参考图为底图生成以保持同一张脸。写剧本时按本集章节选默认造型，AI 也会按剧情在镜头里换造型。
 */
export function CastLooks({
    projectId,
    episodeId,
    dramaType,
    character,
    looks,
    restyle,
    onChanged,
    onDirtyChange,
}: {
    projectId: string;
    episodeId?: string;
    dramaType?: DramaSettings["dramaType"];
    character: DramaCast;
    looks: DramaCast[];
    restyle: boolean;
    onChanged: () => void;
    onDirtyChange?: (dirty: boolean, busy: boolean) => void;
}) {
    const { message, modal } = App.useApp();
    const [adding, setAdding] = useState(false);
    const [editingId, setEditingId] = useState<string>();
    const [libraryLook, setLibraryLook] = useState<DramaCast>();
    const [previewLook, setPreviewLook] = useState<DramaCast>();
    const [formState, setFormState] = useState({ dirty: false, busy: false });
    const [uncertain, setUncertain] = useState<Record<string, { version?: number; resourceId?: string }>>({});
    const operation = useDramaOperationScope(projectId);
    const fileRef = useRef<HTMLInputElement>(null);
    const uploadLookRef = useRef<DramaCast | undefined>(undefined);
    const generationLocked = useRef(false);
    const done = (text: string, affected?: number) => {
        message.success(affected ? `${text}；${affected} 个剧情段的视频已标记为待更新` : text);
        setAdding(false);
        setEditingId(undefined);
        onChanged();
    };
    const add = useMutation({
        mutationFn: (value: LookInput) => addDramaCastLook(projectId, character.id, { ...value, ...(episodeId ? { episodeId } : {}) }),
        onSuccess: () => done("造型已保存，可上传自定义图或单独生成造型图"),
        onError: (error) => message.error(error instanceof Error ? error.message : "添加失败"),
    });
    const remove = useMutation({
        mutationFn: (id: string) => deleteDramaCastLook(projectId, id, restyle),
        onSuccess: (result) => done("已删除造型，引用它的镜头回到角色本体", result.affectedSegments),
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });
    const generate = useMutation({
        mutationFn: async ({ look, accepted, execute, isCurrent }: LookGeneration) => {
            if (generationLocked.current || !isCurrent()) return;
            generationLocked.current = true;
            try {
                if (look.locked) await updateDramaCast(projectId, look.id, { locked: false });
                if (!isCurrent()) return;
                const result = await execute(accepted, restyle, isCurrent);
                if (!result || !isCurrent()) return;
                return { result, isCurrent };
            } finally {
                generationLocked.current = false;
            }
        },
        onSuccess: (completed) => {
            if (completed?.isCurrent()) done("已请求生成造型图", completed.result.affectedSegments);
        },
        onError: (error, input) => {
            if (!input.isCurrent()) return;
            const rejected = error instanceof ApiError && [error.status, error.code].some((status) => status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429);
            if (!(error instanceof CastImageNotSubmittedError) && !rejected) setUncertain((current) => ({ ...current, [input.look.id]: { version: input.look.imageVersion, resourceId: input.look.imageResourceId } }));
            message.error(error instanceof Error ? error.message : "生成失败");
        },
    });
    const upload = useMutation({
        mutationFn: async ({ look, file }: { look: DramaCast; file: File }) => {
            const resource = await uploadResourceFile(file, "image", { fileName: file.name });
            return setDramaCastImage(projectId, look.id, resource.id, restyle);
        },
        onSuccess: (result) => done("自定义造型图已保存并锁定", result.affectedSegments),
        onError: (error) => message.error(error instanceof Error ? error.message : "上传失败"),
    });
    const busy = add.isPending || remove.isPending || generate.isPending || upload.isPending || formState.busy;
    useEffect(() => {
        setUncertain((current) => {
            const next = Object.fromEntries(
                Object.entries(current).filter(([id, previous]) => {
                    const look = looks.find((item) => item.id === id);
                    return look && !mediaBusy(look.imageStatus) && look.imageVersion === previous.version && look.imageResourceId === previous.resourceId;
                }),
            );
            return Object.keys(current).length === Object.keys(next).length ? current : next;
        });
    }, [looks]);
    const stateChange = useRef(onDirtyChange);
    stateChange.current = onDirtyChange;
    useEffect(() => {
        stateChange.current?.(formState.dirty, busy);
    }, [formState.dirty, busy]);
    useEffect(() => () => stateChange.current?.(false, false), []);
    return (
        <div className="drama-field">
            <div className="drama-field-label">
                <span>造型 · 妆造</span>
                <small>
                    角色本体即基础造型；额外妆造最多 {MAX_LOOKS} 套（{looks.length}/{MAX_LOOKS}）
                </small>
            </div>
            <div className="drama-looks">
                {looks.map((look) =>
                    editingId === look.id ? (
                        <LookForm
                            projectId={projectId}
                            episodeId={episodeId}
                            dramaType={dramaType}
                            key={look.id}
                            initial={look}
                            restyleSegments={restyle}
                            onCancel={() => setEditingId(undefined)}
                            onSaved={onChanged}
                            onDirtyChange={(dirty, busy) => setFormState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                        />
                    ) : (
                        <div key={look.id} className="drama-look-item">
                            <div className="drama-look">
                                <button type="button" className="drama-look-thumb" disabled={!look.imageResourceId} aria-label={`放大查看${look.lookName || "造型"}的参考图`} onClick={() => setPreviewLook(look)}>
                                    {look.imageResourceId ? <MediaThumb resourceId={look.imageResourceId} alt={look.lookName || "造型"} /> : <Shirt className="size-4 opacity-40" />}
                                    {mediaBusy(look.imageStatus) ? <span className="drama-look-busy" aria-label="参考图生成中" /> : null}
                                    {look.imageStatus === "failed" ? <AlertCircle className="size-3.5 text-[var(--status-error)]" aria-label="参考图生成失败" /> : null}
                                </button>
                                <span className="drama-look-body">
                                    <b className="truncate">{look.lookName || "未命名造型"}</b>
                                    <small>{chapterLabel(look.lookFromChapter, look.lookToChapter)}</small>
                                    <small>{look.imageStatus === "draft" ? "已保存，待生成或上传" : look.locked ? "自定义图已锁定" : look.imagePrompt ? "使用自定义提示词" : "按外观描述生成"}</small>
                                </span>
                                <span className="drama-look-actions">
                                    <Button size="small" type="text" icon={<Pencil className="size-3.5" />} aria-label={`编辑造型 ${look.lookName}`} disabled={busy || mediaBusy(look.imageStatus)} onClick={() => setEditingId(look.id)} />
                                    <Button size="small" type="text" icon={<Trash2 className="size-3.5" />} aria-label={`删除造型 ${look.lookName}`} disabled={busy} onClick={() => remove.mutate(look.id)} />
                                </span>
                            </div>
                            <div className="drama-look-form-actions">
                                <Button size="small" icon={<Library className="size-3.5" />} disabled={busy || mediaBusy(look.imageStatus)} onClick={() => setLibraryLook(look)}>
                                    素材库
                                </Button>
                                <Button
                                    size="small"
                                    icon={<Upload className="size-3.5" />}
                                    disabled={busy || mediaBusy(look.imageStatus)}
                                    onClick={() => {
                                        uploadLookRef.current = look;
                                        fileRef.current?.click();
                                    }}
                                >
                                    自定义图
                                </Button>
                                <LookGenerationButton
                                    projectId={projectId}
                                    episodeId={episodeId}
                                    look={look}
                                    parentReady={character.imageStatus === "ready" && Boolean(character.imageResourceId)}
                                    busy={busy}
                                    uncertain={Boolean(uncertain[look.id])}
                                    onGenerate={(input) => generate.mutate(input)}
                                />
                                {uncertain[look.id] ? (
                                    <Button
                                        size="small"
                                        disabled={busy}
                                        onClick={async () => {
                                            const ticket = operation.capture();
                                            try {
                                                const latest = (await listDramaCast(projectId)).cast.find((item) => item.id === look.id);
                                                if (!operation.isCurrent(ticket)) return;
                                                if (latest && (mediaBusy(latest.imageStatus) || latest.imageVersion !== look.imageVersion || latest.imageResourceId !== look.imageResourceId)) {
                                                    onChanged();
                                                    message.info("已核对到生成任务或新图片");
                                                } else message.info("尚未核对到新任务或结果，请稍后再次核对");
                                            } catch (error) {
                                                if (operation.isCurrent(ticket)) message.error(error instanceof Error ? error.message : "读取生成状态失败");
                                            }
                                        }}
                                    >
                                        核对生成状态
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    ),
                )}
                {adding ? (
                    <LookForm
                        projectId={projectId}
                        episodeId={episodeId}
                        dramaType={dramaType}
                        submitting={add.isPending}
                        onCancel={() => setAdding(false)}
                        onSubmit={(value) => add.mutate(value)}
                        onDirtyChange={(dirty, busy) => setFormState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                    />
                ) : looks.length < MAX_LOOKS ? (
                    <Button size="small" icon={<Plus className="size-3.5" />} disabled={busy} onClick={() => setAdding(true)}>
                        添加造型
                    </Button>
                ) : null}
            </div>
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    const look = uploadLookRef.current;
                    if (!file || !look) return;
                    if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
                        message.error("请选择不超过 20 MB 的图片");
                        return;
                    }
                    modal.confirm({ title: `采用「${look.lookName}」的自定义图？`, content: "确认后保存并锁定这张图片，不调用模型生成。", okText: "确认保存", cancelText: "取消", onOk: () => upload.mutateAsync({ look, file }) });
                }}
            />
            {previewLook?.imageResourceId ? <CanvasImagePreview storageKey={`resource:${previewLook.imageResourceId}`} alt={previewLook.lookName || "造型"} onClose={() => setPreviewLook(undefined)} /> : null}
            {libraryLook ? (
                <CastLibraryPicker
                    open
                    cast={libraryLook}
                    onClose={() => setLibraryLook(undefined)}
                    onPick={async (resourceId) => {
                        const result = await setDramaCastImage(projectId, libraryLook.id, resourceId, restyle);
                        done("自定义造型图已保存并锁定", result.affectedSegments);
                    }}
                />
            ) : null}
        </div>
    );
}

function LookGenerationButton({
    projectId,
    episodeId,
    look,
    parentReady,
    busy,
    uncertain,
    onGenerate,
}: {
    projectId: string;
    episodeId?: string;
    look: DramaCast;
    parentReady: boolean;
    busy: boolean;
    uncertain: boolean;
    onGenerate: (input: LookGeneration) => void;
}) {
    const operation = useDramaOperationScope(projectId);
    const quote = useCastImageQuote({ projectId, episodeId, cast: look, draft: look.locked ? { unlock: true } : undefined, enabled: parentReady && !busy && !uncertain && !mediaBusy(look.imageStatus) });
    const reason = uncertain ? "生成提交结果待核对" : !parentReady ? "请先生成或上传角色本体图" : quote.isError ? "图片费用读取失败，请重新进入后再试" : quote.data?.reason;
    return (
        <span className="drama-look-generation">
            <Button
                size="small"
                icon={<Play className="size-3.5" />}
                disabled={quote.disabled || busy || !parentReady || mediaBusy(look.imageStatus)}
                loading={quote.isFetching}
                title={reason || undefined}
                onClick={() => {
                    if (quote.disabled || !quote.data || busy) return;
                    const ticket = operation.capture();
                    onGenerate({ look, accepted: quote.data, execute: quote.execute, isCurrent: () => operation.isCurrent(ticket) });
                }}
            >
                {generationLabel("生成图片", quote.data, quote.isFetching)}
            </Button>
            {reason ? <small role="status">{reason}</small> : null}
        </span>
    );
}
