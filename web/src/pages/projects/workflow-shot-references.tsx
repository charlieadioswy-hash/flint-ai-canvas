import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Tooltip } from "antd";
import { ArrowLeft, ArrowLeftRight, Crop, Download, ImagePlus, LoaderCircle, Plus, Replace, X } from "lucide-react";

import { AssetLibraryPickerModal } from "@/components/assets/asset-library-picker-modal";
import { ImageCropDialog, type ImageCropRect } from "@/components/image-crop-dialog";
import { AppModal } from "@/components/ui/product/app-modal";
import { cropDataUrl } from "@/lib/canvas/canvas-image-data";
import { dataUrlToFile } from "@/lib/image-utils";
import { listDramaCast, listDramaTakes, type DramaCast } from "@/services/api/drama";
import { listDramaCastViews } from "@/services/api/drama-cast-views";
import type { DramaShotMediaConfig } from "@/services/api/drama-shot-media";
import { getResource, resourceIdFromStorageKey, uploadResourceFile } from "@/services/api/resources";
import { downloadBrowserMedia } from "@/services/browser-download";
import { getCachedResourceBlob } from "@/services/resource-blob-cache";

import { MediaThumb } from "./drama-shared";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { WorkflowShotImagePreview } from "./workflow-shot-image-preview";
import "./workflow-shot-references.css";

type Target = { role: "reference" | "first" | "last"; replaceId?: string };
type PickedImage = { id: string; name: string; castId?: string };
type Props = {
    projectId: string;
    userId: string;
    kind: "image" | "video";
    config: DramaShotMediaConfig;
    disabled: boolean;
    onChange: (patch: Partial<DramaShotMediaConfig>) => void;
    onBusyChange: (busy: boolean) => void;
    onRefreshReferences: () => void;
};
const KINDS = { character: "角色", scene: "场景", prop: "道具" };

const assetName = (cast: DramaCast) => `${cast.name}${cast.lookName ? ` · ${cast.lookName}` : ""}`;
function imageName(cast: DramaCast) {
    return `${assetName(cast)} · 当前参考图`;
}

function withReferenceSubjects(current: DramaShotMediaConfig, patch: Partial<DramaShotMediaConfig>, image?: PickedImage): Partial<DramaShotMediaConfig> {
    const next = { ...current, ...patch };
    const subjects = { ...current.referenceSubjects };
    if (image) {
        if (image.castId) subjects[image.id] = image.castId;
        else delete subjects[image.id];
    }
    const ids = [...next.referenceResourceIds, next.firstFrameResourceId, next.lastFrameResourceId];
    return { ...patch, referenceSubjects: Object.fromEntries(Object.entries(subjects).filter(([id]) => ids.includes(id))) };
}

/** 当前镜头的图片绑定；裁剪、换图均不修改项目主体的原图或采用版本。 */
export function WorkflowShotReferences({ projectId, userId, kind, config, disabled, onChange, onBusyChange, onRefreshReferences }: Props) {
    const scope = useDramaOperationScope(projectId);
    const latest = useRef({ config, onChange });
    latest.current = { config, onChange };
    const casts = useQuery({ queryKey: ["drama-shot-reference-cast", userId, projectId], queryFn: ({ signal }) => listDramaCast(projectId, signal), staleTime: 20_000 });
    const [picker, setPicker] = useState<{ target: Target; cast?: DramaCast }>();
    const [preview, setPreview] = useState<{ id: string; name: string }>();
    const [library, setLibrary] = useState<Target>();
    const [crop, setCrop] = useState<{ target: Target; image: PickedImage; url: string }>();
    const [working, setWorking] = useState("");
    const [error, setError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const downloadAbort = useRef<AbortController | undefined>(undefined);
    const uploadTarget = useRef<Target>({ role: "reference" });
    const locked = useRef(false);
    const frameMode = kind === "video" && config.operation === "image_to_video";
    const disabledActions = disabled || Boolean(working);
    const castRows = casts.data?.cast || [];
    const changedReferences =
        kind === "video" && config.operation === "reference_to_video"
            ? config.referenceResourceIds
                  .flatMap((id) => {
                      const castId = config.referenceSubjects?.[id];
                      const adopted = castId && castRows.find((cast) => cast.id === castId)?.imageResourceId;
                      return adopted && adopted !== id ? [id, adopted] : [];
                  })
                  .join("\n")
            : "";
    useEffect(() => {
        if (changedReferences) onRefreshReferences();
    }, [changedReferences, onRefreshReferences]);
    useEffect(() => onBusyChange(Boolean(working || crop)), [working, crop, onBusyChange]);
    useEffect(() => () => onBusyChange(false), [onBusyChange]);
    useEffect(() => {
        const controller = new AbortController();
        downloadAbort.current = controller;
        return () => controller.abort();
    }, []);
    useEffect(
        () => () => {
            if (crop) URL.revokeObjectURL(crop.url);
        },
        [crop],
    );

    const nameOf = (id: string, index = 0) => {
        const subject = castRows.find((cast) => cast.id === config.referenceSubjects?.[id]) || castRows.find((cast) => cast.imageResourceId === id);
        return config.referenceNames?.[id] || (subject ? (subject.imageResourceId === id ? imageName(subject) : assetName(subject)) : `参考图片 ${index + 1}`);
    };
    const apply = (target: Target, image: PickedImage) => {
        const current = latest.current.config;
        const referenceNames = {
            ...current.referenceNames,
            [image.id]: Array.from(image.name.trim() || "参考图片")
                .slice(0, 120)
                .join(""),
        };
        if (target.role === "reference") {
            const ids = current.referenceResourceIds;
            if (target.replaceId && !ids.includes(target.replaceId)) throw new Error("这张参考图已变化，请重新选择");
            if (image.id !== target.replaceId && ids.includes(image.id)) throw new Error("已添加这张参考图");
            const next = target.replaceId ? ids.map((id) => (id === target.replaceId ? image.id : id)) : [...ids, image.id];
            if (next.length > 20) throw new Error("参考图片最多 20 张");
            latest.current.onChange(withReferenceSubjects(current, { referenceResourceIds: next, referenceNames, firstFrameResourceId: "", lastFrameResourceId: "", operation: kind === "image" ? "image_to_image" : "reference_to_video" }, image));
        } else {
            latest.current.onChange(withReferenceSubjects(current, { [target.role === "first" ? "firstFrameResourceId" : "lastFrameResourceId"]: image.id, referenceNames, referenceResourceIds: [], operation: "image_to_video" }, image));
        }
        setError("");
    };
    const run = async (label: string, action: (ticket: ReturnType<typeof scope.capture>) => Promise<void>) => {
        if (locked.current) return;
        locked.current = true;
        const ticket = scope.capture();
        setWorking(label);
        setError("");
        try {
            await action(ticket);
        } catch (reason) {
            if (scope.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "图片操作失败");
        } finally {
            locked.current = false;
            if (scope.isCurrent(ticket)) setWorking("");
        }
    };
    const choose = (target: Target, image: PickedImage) => {
        try {
            apply(target, image);
            setPicker(undefined);
            setLibrary(undefined);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "选择图片失败");
            throw reason;
        }
    };
    const upload = (target: Target) => {
        uploadTarget.current = target;
        fileInput.current?.click();
    };
    const uploadFile = (file: File, target: Target) =>
        run("正在上传图片…", async (ticket) => {
            if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) throw new Error("请选择不超过 20 MB 的图片");
            const resource = await uploadResourceFile(file, "image", { fileName: file.name });
            if (!scope.isCurrent(ticket)) return;
            if (resource.status !== "ready" || !resource.mimeType.startsWith("image/")) throw new Error("图片尚未上传完成，请重试");
            choose(target, { id: resource.id, name: file.name.replace(/\.[^.]+$/, "") });
        });
    const beginCrop = (target: Target, image: PickedImage) =>
        run("正在读取原图…", async (ticket) => {
            const blob = await getCachedResourceBlob(`resource:${image.id}`);
            if (!scope.isCurrent(ticket)) return;
            if (!blob) throw new Error("图片文件未能读取，请重试");
            setCrop({ target, image, url: URL.createObjectURL(blob) });
        });
    const finishCrop = (selection: ImageCropRect) => {
        if (!crop) return;
        const current = crop;
        void run("正在应用裁剪…", async (ticket) => {
            const dataUrl = await cropDataUrl(current.url, selection);
            if (!scope.isCurrent(ticket)) return;
            const name = `${current.image.name} · 裁剪`;
            const file = await dataUrlToFile({ id: current.image.id, dataUrl, name: `${name}.png`, type: "image/png" });
            const resource = await uploadResourceFile(file, "image", { fileName: file.name });
            if (!scope.isCurrent(ticket)) return;
            if (resource.status !== "ready" || !resource.mimeType.startsWith("image/")) throw new Error("裁剪图片尚未保存，请重试");
            const castId = kind === "video" && current.target.role === "reference" ? undefined : current.image.castId;
            apply(current.target, { id: resource.id, name, castId });
            setCrop(undefined);
        });
    };
    const remove = (target: Target) => {
        const current = latest.current.config;
        if (target.role === "reference") onChange(withReferenceSubjects(current, { referenceResourceIds: current.referenceResourceIds.filter((id) => id !== target.replaceId) }));
        else onChange(withReferenceSubjects(current, { [target.role === "first" ? "firstFrameResourceId" : "lastFrameResourceId"]: "" }));
    };
    const card = (target: Target, id: string, label: string, index = 0) => {
        const name = id ? nameOf(id, index) : label;
        const cast = casts.data?.cast.find((item) => item.id === config.referenceSubjects?.[id]) || casts.data?.cast.find((item) => item.imageResourceId === id);
        return (
            <div className={`shot-reference-card ${target.role !== "reference" ? "is-frame" : ""}`} key={target.role === "reference" ? id : target.role}>
                <Tooltip title={id ? "预览图片" : `添加${label}`} placement="top">
                    <button
                        type="button"
                        className="shot-reference-image"
                        aria-label={id ? `预览${target.role === "reference" ? name : label}` : `选择${label.replace("图", "")}`}
                        disabled={!id && disabledActions}
                        onClick={() => {
                            setError("");
                            if (id) setPreview({ id, name });
                            else setPicker({ target, cast });
                        }}
                    >
                        {id ? <MediaThumb resourceId={id} alt={name} /> : <Plus aria-hidden />}
                    </button>
                </Tooltip>
                {id ? (
                    <div className="shot-reference-tools">
                        <Tooltip title="换图" placement="top">
                            <button
                                type="button"
                                aria-label={`切换${target.role === "reference" ? name : label}`}
                                disabled={disabledActions}
                                onClick={() => {
                                    setError("");
                                    setPicker({ target, cast });
                                }}
                            >
                                <Replace aria-hidden />
                            </button>
                        </Tooltip>
                        <Tooltip title="裁剪图片" placement="top">
                            <button type="button" aria-label={`裁剪${label}`} disabled={disabledActions} onClick={() => void beginCrop(target, { id, name, castId: cast?.id })}>
                                <Crop aria-hidden />
                            </button>
                        </Tooltip>
                        <Tooltip title="下载图片" placement="top">
                            <button
                                type="button"
                                aria-label={`下载${label}`}
                                disabled={disabledActions}
                                onClick={() =>
                                    void run("正在准备下载…", async (ticket) => {
                                        const resource = await getResource(id);
                                        if (!scope.isCurrent(ticket)) return;
                                        const extension =
                                            ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff" } as Record<string, string>)[
                                                resource.mimeType.split(";")[0].trim().toLowerCase()
                                            ] || /\.([a-z0-9]{1,8})$/i.exec(resource.objectKey)?.[1];
                                        await downloadBrowserMedia({ storageKey: `resource:${id}`, fileName: extension ? `${name}.${extension}` : name }, downloadAbort.current?.signal);
                                    })
                                }
                            >
                                <Download aria-hidden />
                            </button>
                        </Tooltip>
                        <Tooltip title="移除图片" placement="top">
                            <button type="button" aria-label={`移除${label}`} disabled={disabledActions} onClick={() => remove(target)}>
                                <X aria-hidden />
                            </button>
                        </Tooltip>
                    </div>
                ) : null}
                <span className="shot-reference-name" title={name}>
                    {target.role === "reference" ? name : label}
                </span>
            </div>
        );
    };
    return (
        <>
            <section className="shot-reference-panel" aria-label={frameMode ? "首尾帧图片" : "参考内容"}>
                <header className="shot-reference-header">
                    <strong>{frameMode ? "首尾帧" : "参考内容"}</strong>
                    {!frameMode ? (
                        <div className="shot-reference-add-actions">
                            <button type="button" disabled={disabledActions || config.referenceResourceIds.length >= 20} onClick={() => upload({ role: "reference" })}>
                                <Plus aria-hidden />
                                本地上传
                            </button>
                            <button
                                type="button"
                                disabled={disabledActions || config.referenceResourceIds.length >= 20}
                                onClick={() => {
                                    setError("");
                                    setPicker({ target: { role: "reference" } });
                                }}
                            >
                                <Plus aria-hidden />
                                主体
                            </button>
                        </div>
                    ) : null}
                </header>
                {frameMode ? (
                    <div className="shot-reference-frames">
                        {card({ role: "first" }, config.firstFrameResourceId || "", "首帧图")}
                        <Tooltip title="交换首尾帧" placement="top">
                            <button
                                type="button"
                                className="shot-reference-swap"
                                aria-label="交换首尾帧"
                                disabled={disabledActions || (!config.firstFrameResourceId && !config.lastFrameResourceId)}
                                onClick={() => onChange({ firstFrameResourceId: config.lastFrameResourceId || "", lastFrameResourceId: config.firstFrameResourceId || "" })}
                            >
                                <ArrowLeftRight aria-hidden />
                            </button>
                        </Tooltip>
                        {card({ role: "last" }, config.lastFrameResourceId || "", "尾帧图")}
                    </div>
                ) : (
                    <div className="shot-reference-grid">
                        {config.referenceResourceIds.map((id, index) => card({ role: "reference", replaceId: id }, id, `参考图 ${index + 1}`, index))}
                        {!config.referenceResourceIds.length ? (
                            <button type="button" className="shot-reference-empty" disabled={disabledActions} onClick={() => setPicker({ target: { role: "reference" } })}>
                                <ImagePlus aria-hidden />
                                <span>添加参考内容</span>
                            </button>
                        ) : null}
                    </div>
                )}
                {working ? (
                    <p role="status">
                        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                        {working}
                    </p>
                ) : null}
                {error ? (
                    <p role="alert" className="shot-reference-error">
                        {error}
                    </p>
                ) : null}
                <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept="image/*"
                    aria-label="上传镜头参考图片"
                    onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void uploadFile(file, uploadTarget.current);
                    }}
                />
            </section>
            {preview ? <WorkflowShotImagePreview key={preview.id} resourceId={preview.id} name={preview.name} onClose={() => setPreview(undefined)} /> : null}
            {picker ? (
                <SubjectPicker
                    projectId={projectId}
                    userId={userId}
                    casts={casts.data?.cast || []}
                    loading={casts.isPending}
                    failed={casts.isError}
                    initialCast={picker.cast}
                    latestOnly={kind === "video" && picker.target.role === "reference"}
                    disabled={Boolean(working)}
                    onRetry={() => void casts.refetch()}
                    onClose={() => setPicker(undefined)}
                    onUpload={() => upload(picker.target)}
                    onLibrary={() => {
                        setLibrary(picker.target);
                        setPicker(undefined);
                    }}
                    onPick={(image) => {
                        try {
                            choose(picker.target, image);
                        } catch {
                            /* Inline error keeps the current selection. */
                        }
                    }}
                    error={error}
                />
            ) : null}
            <AssetLibraryPickerModal
                open={Boolean(library)}
                remoteLibrary
                acceptRemoteItems
                remoteKind="image"
                mediaKinds={["image"]}
                multiple={false}
                items={[]}
                categoryLabels={{ all: "全部素材" }}
                title={library?.role === "first" ? "选择首帧" : library?.role === "last" ? "选择尾帧" : "选择参考图"}
                onClose={() => setLibrary(undefined)}
                remoteItemDisabledReason={(asset) => (asset.kind === "image" && resourceIdFromStorageKey(asset.data.storageKey) ? undefined : "请选择已保存的图片")}
                onConfirm={(_ids, items) => {
                    const item = items?.[0];
                    const asset = item?.asset;
                    const id = asset?.kind === "image" ? resourceIdFromStorageKey(asset.data.storageKey) : "";
                    if (!id || !library) throw new Error("图片还没有保存到服务器");
                    choose(library, { id, name: item?.title || "素材库图片" });
                }}
            />
            {crop ? <ImageCropDialog open dataUrl={crop.url} title="裁剪参考图片" confirmLoading={Boolean(working)} errorMessage={error} onClose={() => setCrop(undefined)} onConfirm={finishCrop} /> : null}
        </>
    );
}

function SubjectPicker({
    projectId,
    userId,
    casts,
    loading,
    failed,
    initialCast,
    latestOnly,
    disabled,
    error,
    onRetry,
    onClose,
    onPick,
    onUpload,
    onLibrary,
}: {
    projectId: string;
    userId: string;
    casts: DramaCast[];
    loading: boolean;
    failed: boolean;
    initialCast?: DramaCast;
    latestOnly: boolean;
    disabled: boolean;
    error: string;
    onRetry: () => void;
    onClose: () => void;
    onPick: (image: PickedImage) => void;
    onUpload: () => void;
    onLibrary: () => void;
}) {
    const [kind, setKind] = useState<keyof typeof KINDS>(initialCast?.kind || "character");
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState(latestOnly ? undefined : initialCast);
    const visible = casts.filter((cast) => cast.kind === kind && `${cast.name} ${cast.lookName || ""}`.includes(search.trim()));
    return (
        <AppModal open title={selected ? `切换「${selected.name}」的设定图` : "选择主体图片"} width={760} footer={null} onCancel={onClose} closable={!disabled} mask={{ closable: !disabled }} keyboard={!disabled}>
            <div className="shot-reference-picker">
                <div className="shot-reference-picker-toolbar">
                    {selected ? (
                        <Button disabled={disabled} icon={<ArrowLeft className="size-4" />} onClick={() => setSelected(undefined)}>
                            全部主体
                        </Button>
                    ) : (
                        <Input aria-label="搜索主体图片" placeholder="搜索角色、场景、道具" value={search} onChange={(event) => setSearch(event.target.value)} />
                    )}
                    <Button disabled={disabled} onClick={onUpload}>
                        本地上传
                    </Button>
                    <Button disabled={disabled} onClick={onLibrary}>
                        素材库
                    </Button>
                </div>
                {error ? (
                    <p role="alert" className="shot-reference-error">
                        {error}
                    </p>
                ) : null}
                {selected ? (
                    <SubjectImages projectId={projectId} userId={userId} cast={selected} casts={casts} disabled={disabled} onPick={onPick} />
                ) : (
                    <>
                        <nav className="shot-reference-picker-tabs" aria-label="主体类型">
                            {(Object.keys(KINDS) as Array<keyof typeof KINDS>).map((key) => (
                                <button type="button" key={key} aria-pressed={key === kind} onClick={() => setKind(key)}>
                                    {KINDS[key]}
                                </button>
                            ))}
                        </nav>
                        {loading ? (
                            <p role="status">正在读取主体…</p>
                        ) : failed ? (
                            <p role="alert">
                                主体读取失败 <Button onClick={onRetry}>重新读取</Button>
                            </p>
                        ) : (
                            <div className="shot-reference-picker-grid">
                                {visible.map((cast) => (
                                    <div key={cast.id}>
                                        <button type="button" disabled={disabled || !cast.imageResourceId} onClick={() => onPick({ id: cast.imageResourceId!, name: imageName(cast), castId: cast.id })}>
                                            {cast.imageResourceId ? <MediaThumb resourceId={cast.imageResourceId} alt={cast.name} /> : <ImagePlus aria-hidden />}
                                            <strong>
                                                {cast.name}
                                                {cast.lookName ? ` · ${cast.lookName}` : ""}
                                            </strong>
                                            <small>{cast.imageResourceId ? "当前设定图" : "尚未生成图片"}</small>
                                        </button>
                                        {!latestOnly ? (
                                            <button type="button" disabled={disabled} onClick={() => setSelected(cast)}>
                                                查看其他设定图
                                            </button>
                                        ) : null}
                                    </div>
                                ))}
                                {!visible.length ? (
                                    <p>
                                        暂无{search ? "匹配的" : "可选的"}
                                        {KINDS[kind]}
                                    </p>
                                ) : null}
                            </div>
                        )}
                    </>
                )}
            </div>
        </AppModal>
    );
}

function SubjectImages({ projectId, userId, cast, casts, disabled, onPick }: { projectId: string; userId: string; cast: DramaCast; casts: DramaCast[]; disabled: boolean; onPick: (image: PickedImage) => void }) {
    const versions = useQuery({ queryKey: ["drama-shot-reference-versions", userId, projectId, cast.id], queryFn: ({ signal }) => listDramaTakes(projectId, cast.id, "cast", signal) });
    const views = useQuery({ queryKey: ["drama-shot-reference-views", userId, projectId, cast.id], queryFn: ({ signal }) => listDramaCastViews(projectId, cast.id, signal) });
    const familyId = cast.parentId || cast.id;
    const images: PickedImage[] = casts.filter((item) => (item.id === familyId || item.parentId === familyId) && item.imageResourceId).map((item) => ({ id: item.imageResourceId!, name: imageName(item), castId: item.id }));
    for (const take of versions.data?.takes || []) if (take.resourceId) images.push({ id: take.resourceId, name: `${cast.name} · 版本 ${take.version}`, castId: cast.id });
    for (const view of views.data?.views || []) {
        if (view.resourceId) images.push({ id: view.resourceId, name: `${cast.name} · ${view.config.name}`, castId: cast.id });
        for (const take of view.takes) if (take.resourceId && ["ready", "succeeded"].includes(take.status)) images.push({ id: take.resourceId, name: `${cast.name} · ${view.config.name} · 版本 ${take.version}`, castId: cast.id });
    }
    // 同一张图可对应多个历史版本。优先保留当前主体图，再按返回顺序选用最新的历史记录。
    const unique = new Map<string, PickedImage>();
    for (const image of images) if (!unique.has(image.id)) unique.set(image.id, image);
    return (
        <div className="shot-reference-variants">
            {versions.isPending || views.isPending ? <p role="status">正在读取其他设定图…</p> : null}
            {versions.isError || views.isError ? (
                <p role="alert">
                    部分设定图读取失败{" "}
                    <Button
                        onClick={() => {
                            void versions.refetch();
                            void views.refetch();
                        }}
                    >
                        重新读取
                    </Button>
                </p>
            ) : null}
            <div className="shot-reference-picker-grid">
                {[...unique.values()].map((image) => (
                    <button key={image.id} type="button" disabled={disabled} onClick={() => onPick(image)}>
                        <MediaThumb resourceId={image.id} alt={image.name} />
                        <strong>{image.name}</strong>
                    </button>
                ))}
            </div>
            {!unique.size && !versions.isPending && !views.isPending ? <p>暂无可选设定图，可使用本地上传或素材库图片。</p> : null}
        </div>
    );
}
