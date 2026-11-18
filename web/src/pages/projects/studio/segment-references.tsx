import { useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button, Input, Popover } from "antd";
import { ArrowDown, ArrowUp, Check, Library, Plus, RotateCcw, Search, Trash2, Upload, ZoomIn } from "lucide-react";

import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import type { DramaCast, DramaSegment, DramaSegmentReferencePatch, DramaShot } from "@/services/api/drama";
import { uploadResourceFile } from "@/services/api/resources";
import { MediaThumb, parseList } from "../drama-shared";
import { CastLibraryPicker } from "./cast-library-picker";
import { CastVoicePreview } from "./cast-voice";
import { referenceMissingReason } from "./segment-parts";
import "./segment-references.css";

const ASSET_KINDS = ["character", "scene", "prop"] as const;
const KIND_LABEL = { character: "人物", scene: "场景", prop: "道具", image: "附加图片" };
type AssetKind = keyof typeof KIND_LABEL;
type Reference = DramaSegment["request"]["references"][number];

function moved<T>(items: T[], from: number, to: number) {
    const result = [...items];
    const [item] = result.splice(from, 1);
    result.splice(to, 0, item);
    return result;
}

function castName(cast: DramaCast) {
    return `${cast.name}${cast.lookName ? ` · ${cast.lookName}` : ""}`;
}

/** 缩略图遵循请求顺序，详细选择与音色控制留在参考资产菜单。 */
export function ReferenceBoard({
    segment,
    shots,
    castById,
    busy: saving,
    onSave,
    onOpenCast,
}: {
    segment: DramaSegment;
    shots: DramaShot[];
    castById: Map<string, DramaCast>;
    busy: boolean;
    onSave: (patch: DramaSegmentReferencePatch) => Promise<unknown>;
    onOpenCast: (id: string) => void;
}) {
    const { message } = App.useApp();
    const [menuOpen, setMenuOpen] = useState(false);
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [voiceDraft, setVoiceDraft] = useState<string[] | null>(null);
    const [savingVoice, setSavingVoice] = useState(false);
    const [voiceError, setVoiceError] = useState("");
    const voiceSaveLock = useRef(false);
    const mounted = useRef(true);
    const [preview, setPreview] = useState<{ resourceId: string; name: string }>();
    const fileRef = useRef<HTMLInputElement>(null);
    const railRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        const rail = railRef.current;
        if (!rail) return;
        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey) return;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientWidth : 1;
            rail.scrollLeft += delta * scale;
        };
        // 原生非 passive 监听在滚动边界也阻止父弹窗滚动。
        rail.addEventListener("wheel", onWheel, { passive: false });
        return () => rail.removeEventListener("wheel", onWheel);
    }, []);
    const busy = saving || uploading || savingVoice;
    const openPreview = (image: { resourceId: string; name: string }) => {
        setMenuOpen(false);
        setPreview(image);
    };
    const openCast = (id: string) => {
        setMenuOpen(false);
        onOpenCast(id);
    };
    const { request } = segment;
    const ids = request.references.filter((ref) => ref.castId).map((ref) => ref.castId);
    const images = request.references.filter((ref) => !ref.castId && ref.resourceId).map((ref) => ({ resourceId: ref.resourceId!, name: ref.name }));
    const refsById = new Map(request.references.filter((ref) => ref.castId).map((ref) => [ref.castId, ref]));
    const selectedVoices = voiceDraft ?? (request.audioReferences || []).map((voice) => voice.castId);
    const audioLimit = request.modelMaxAudios || 0;
    useEffect(() => {
        if (!savingVoice && !voiceError && voiceDraft && JSON.stringify(voiceDraft) === JSON.stringify((request.audioReferences || []).map((voice) => voice.castId))) setVoiceDraft(null);
    }, [request.audioReferences, savingVoice, voiceDraft, voiceError]);
    const saveVoices = async (next: string[]) => {
        if (voiceSaveLock.current || saving || uploading) return;
        voiceSaveLock.current = true;
        setVoiceDraft(next);
        setVoiceError("");
        setSavingVoice(true);
        try {
            await onSave({ audioCastIds: next });
        } catch (error) {
            if (mounted.current) setVoiceError(error instanceof Error ? error.message : "音色选择未能保存，请重试");
        } finally {
            voiceSaveLock.current = false;
            if (mounted.current) setSavingVoice(false);
        }
    };
    const save = (patch: DramaSegmentReferencePatch) => {
        // 父层 mutation 显示错误；失败后不替换服务端选择。
        void onSave(patch).catch(() => {});
    };
    const saveIDs = (next: string[]) => save({ referenceCastIds: next });
    const toggleCast = (cast: DramaCast) => {
        if (ids.includes(cast.id)) saveIDs(ids.filter((id) => id !== cast.id));
        else saveIDs([...ids, cast.id]);
    };
    const addImage = async (resourceId: string, name: string) => {
        if (request.references.some((ref) => ref.resourceId === resourceId)) {
            message.info("本段已添加这张参考图");
            return;
        }
        await onSave({ referenceImages: [...images, { resourceId, name }] });
    };
    const upload = async (file: File) => {
        if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
            message.error("请选择不超过 20 MB 的图片");
            return;
        }
        setUploading(true);
        try {
            const resource = await uploadResourceFile(file, "image", { fileName: file.name });
            await addImage(resource.id, file.name.replace(/\.[^.]+$/, ""));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "添加参考图失败");
        } finally {
            setUploading(false);
        }
    };

    const moveCast = (cast: DramaCast, direction: number) => {
        const index = ids.indexOf(cast.id);
        const target = index + direction;
        if (index >= 0 && target >= 0 && target < ids.length) saveIDs(moved(ids, index, target));
    };

    const visible = new Set(ids);
    for (const shot of shots) {
        for (const id of [...parseList(shot.castIdsJson), ...parseList(shot.lookCastIdsJson), ...parseList(shot.propIdsJson), shot.sceneCastId || ""]) {
            if (id) visible.add(id);
        }
    }
    // 没选参考图的说话人仍需保留人物卡，让音色可以独立关闭。
    for (const id of new Set([...selectedVoices, ...(request.audioReferences || []).map((voice) => voice.castId)])) {
        if (!ids.some((castId) => (castById.get(castId)?.parentId || castId) === id)) visible.add(id);
    }
    for (const id of visible) {
        const parentId = castById.get(id)?.parentId;
        if (parentId && !ids.includes(parentId)) visible.delete(parentId);
    }
    const voiceControls = (cast: DramaCast) => {
        const character = cast.parentId ? castById.get(cast.parentId) : cast;
        if (!character || character.kind !== "character") return null;
        const selected = selectedVoices.includes(character.id);
        const audio = request.audioReferences?.find((voice) => voice.castId === character.id);
        return (
            <div className="drama-sdx-asset-voice" aria-label={`${character.name}音色`}>
                <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${selected ? "关闭" : "开启"}${character.name}的音色`}
                    disabled={busy || (!selected && (!character.voiceSampleResourceId || selectedVoices.length >= audioLimit))}
                    onClick={() => void saveVoices(selected ? selectedVoices.filter((id) => id !== character.id) : [...selectedVoices, character.id])}
                >
                    {selected ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}音色{selected ? "已开启" : "已关闭"}
                </button>
                <CastVoicePreview resourceId={character.voiceSampleResourceId} name={character.name} />
                <small>{savingVoice ? "正在应用音色选择…" : audio ? (audio.sent ? `${audio.label} · 随请求发送` : audio.note) : !character.voiceSampleResourceId ? "请在角色设定中绑定音频" : cast.parentId ? "沿用角色本体音色" : ""}</small>
            </div>
        );
    };
    const renderCast = (cast: DramaCast) => {
        const ref = refsById.get(cast.id);
        const index = ids.indexOf(cast.id);
        return (
            <AssetCard
                key={cast.id}
                name={castName(cast)}
                kind={KIND_LABEL[cast.kind]}
                resourceId={ref?.resourceId || cast.imageResourceId}
                badge={ref?.label}
                checked={Boolean(ref)}
                disabled={busy}
                note={ref ? (ref.sent ? "随请求发送" : `未附图：${referenceMissingReason(segment, cast, ref.resourceId)}`) : "未选用参考图"}
                onToggle={() => toggleCast(cast)}
                onOpen={() => openCast(cast.id)}
                onPreview={openPreview}
                onRaise={index > 0 ? () => moveCast(cast, -1) : undefined}
                onLower={index >= 0 && index < ids.length - 1 ? () => moveCast(cast, 1) : undefined}
            >
                {voiceControls(cast)}
            </AssetCard>
        );
    };
    const renderImage = (ref: Reference) => {
        const index = images.findIndex((image) => image.resourceId === ref.resourceId);
        return (
            <AssetCard
                key={ref.resourceId}
                name={ref.name}
                kind={KIND_LABEL.image}
                resourceId={ref.resourceId}
                badge={ref.label}
                checked
                disabled={busy}
                note={ref.sent ? "随请求发送" : `未附图：${referenceMissingReason(segment, undefined, ref.resourceId)}`}
                onToggle={() => save({ referenceImages: images.filter((image) => image.resourceId !== ref.resourceId) })}
                onPreview={openPreview}
                onRaise={index > 0 ? () => save({ referenceImages: moved(images, index, index - 1) }) : undefined}
                onLower={index < images.length - 1 ? () => save({ referenceImages: moved(images, index, index + 1) }) : undefined}
            />
        );
    };
    const first = segment.index === 0 && !request.firstFrameResourceId && !request.firstFramePending;
    const voiceActions = (
        <>
            {segment.audioReferenceMode === "custom" ? (
                <Button
                    size="small"
                    type="text"
                    disabled={busy}
                    onClick={() => {
                        void onSave({ autoAudioReferences: true })
                            .then(() => {
                                if (mounted.current) {
                                    setVoiceDraft(null);
                                    setVoiceError("");
                                }
                            })
                            .catch(() => {});
                    }}
                >
                    恢复自动音色
                </Button>
            ) : null}
            {voiceError ? (
                <p role="alert">
                    {voiceError}
                    <Button size="small" disabled={busy || selectedVoices.length > audioLimit} onClick={() => void saveVoices(selectedVoices)}>
                        重试音色选择
                    </Button>
                </p>
            ) : null}
        </>
    );
    return (
        <section className="drama-sdx-section drama-sdx-reference-board" aria-label="本段参考资产">
            <div className="drama-sdx-section-head">
                <span className="drama-sdx-count">
                    本段参考 {request.references.filter((ref) => ref.sent).length}/{request.references.length}
                </span>
                <Popover
                    trigger="click"
                    placement="bottomLeft"
                    destroyOnHidden
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    content={
                        <AssetMenu
                            casts={[...castById.values()]}
                            images={request.references.filter((ref) => !ref.castId)}
                            ids={ids}
                            busy={busy}
                            renderCast={renderCast}
                            renderImage={renderImage}
                            details={
                                <>
                                    <div className="drama-sdx-assets-foot">
                                        <small>
                                            {segment.referenceMode === "custom" ? "手动指定" : "按镜头自动取"} · 本段最多发送 {request.referenceCapacity} 张{request.modelMaxImages ? ` · 模型上限 ${request.modelMaxImages} 张（含首帧）` : ""}
                                        </small>
                                        {segment.referenceMode === "custom" ? (
                                            <Button size="small" type="text" disabled={busy} icon={<RotateCcw className="size-3.5" />} onClick={() => save({ autoReferences: true })}>
                                                恢复自动参考
                                            </Button>
                                        ) : null}
                                    </div>
                                    <div className="drama-sdx-frame-note">
                                        <span>{first ? "开场段：无首帧，按提示词与参考图生成" : request.firstFrameResourceId ? `首帧：第 ${segment.index} 段尾帧` : `首帧：等待第 ${segment.index} 段视频生成`}</span>
                                    </div>
                                </>
                            }
                            voiceActions={
                                <>
                                    <small>
                                        音色 {selectedVoices.length}/{audioLimit} · {segment.audioReferenceMode === "custom" ? "手动选择" : "按对白自动开启"} · {audioLimit ? `当前模型音色不可多于 ${audioLimit} 个` : "当前模型不支持参考音色"}
                                    </small>
                                    {voiceActions}
                                    {selectedVoices.length > audioLimit ? <p className="drama-sdx-hint is-error">已选音色超过模型上限，请在人物卡片下关闭部分音色。</p> : null}
                                </>
                            }
                            onLibrary={() => {
                                setMenuOpen(false);
                                setLibraryOpen(true);
                            }}
                            onUpload={() => fileRef.current?.click()}
                        />
                    }
                >
                    <Button size="small" icon={<Search className="size-3.5" />} aria-expanded={menuOpen}>
                        管理参考资产
                    </Button>
                </Popover>
                <Button size="small" icon={<Library className="size-3.5" />} disabled={busy} onClick={() => setLibraryOpen(true)}>
                    素材库
                </Button>
                <Button size="small" icon={<Upload className="size-3.5" />} loading={uploading} disabled={busy} onClick={() => fileRef.current?.click()}>
                    上传参考图
                </Button>
            </div>
            <div ref={railRef} className="drama-sdx-reference-rail" role="region" aria-label="参考资产缩略图" tabIndex={0} data-canvas-wheel-scroll>
                {request.firstFrameResourceId ? (
                    <ReferenceTile
                        name="上一段尾帧"
                        resourceId={request.firstFrameResourceId}
                        label="预览上一段尾帧"
                        title={`首帧：第 ${segment.index} 段尾帧`}
                        onOpen={() => openPreview({ resourceId: request.firstFrameResourceId!, name: "上一段尾帧" })}
                    />
                ) : null}
                {request.references.map((ref, index) => {
                    const cast = castById.get(ref.castId);
                    const name = cast ? castName(cast) : ref.name;
                    const resourceId = ref.resourceId || cast?.imageResourceId;
                    return (
                        <ReferenceTile
                            key={`${ref.castId || ref.resourceId}-${index}`}
                            name={name}
                            resourceId={resourceId}
                            label={cast ? `查看${name}设定` : `放大预览${name}`}
                            title={`${ref.label} · ${name}${ref.sent ? "" : ` · 未附图：${referenceMissingReason(segment, cast, ref.resourceId)}`}`}
                            onOpen={cast ? () => openCast(cast.id) : resourceId ? () => openPreview({ resourceId, name }) : undefined}
                        />
                    );
                })}
                {[...visible]
                    .filter((id) => !ids.includes(id))
                    .map((id) => {
                        const cast = castById.get(id);
                        if (!cast) return null;
                        const name = castName(cast);
                        return <ReferenceTile key={id} name={name} resourceId={cast.imageResourceId} label={`查看${name}设定`} title={`${name} · 关联资产，未选用参考图`} related onOpen={() => openCast(cast.id)} />;
                    })}
                {!request.references.length && !request.firstFrameResourceId && !visible.size ? <p className="drama-sdx-hint">暂无参考资产，可在“管理参考资产”中添加。</p> : null}
            </div>
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload(file);
                }}
            />
            <CastLibraryPicker open={libraryOpen} cast={{ kind: "character", name: segment.title }} segment onClose={() => setLibraryOpen(false)} onPick={addImage} />
            {preview ? <CanvasImagePreview storageKey={`resource:${preview.resourceId}`} alt={preview.name} onClose={() => setPreview(undefined)} /> : null}
        </section>
    );
}

function ReferenceTile({ name, resourceId, label, title, related, onOpen }: { name: string; resourceId?: string; label: string; title: string; related?: boolean; onOpen?: () => void }) {
    return (
        <button type="button" className={`drama-sdx-reference-tile${related ? " is-related" : ""}`} aria-label={label} title={title} disabled={!onOpen} onClick={onOpen}>
            {resourceId ? <MediaThumb resourceId={resourceId} alt={name} fallback={<span className="drama-sdx-reference-name">{name}</span>} /> : <span className="drama-sdx-reference-name">{name}</span>}
            {onOpen ? (
                <span className="drama-sdx-reference-zoom" aria-hidden="true">
                    <ZoomIn className="size-4" />
                </span>
            ) : null}
        </button>
    );
}

/** 二级资产菜单保留已选项；搜索角色名、别名或造型名后可直接添加或移除。 */
function AssetMenu({
    casts,
    images,
    ids,
    busy,
    renderCast,
    renderImage,
    details,
    voiceActions,
    onLibrary,
    onUpload,
}: {
    casts: DramaCast[];
    images: Reference[];
    ids: string[];
    busy: boolean;
    renderCast: (cast: DramaCast) => ReactNode;
    renderImage: (ref: Reference) => ReactNode;
    details: ReactNode;
    voiceActions: ReactNode;
    onLibrary: () => void;
    onUpload: () => void;
}) {
    const [kind, setKind] = useState<AssetKind | "all">("all");
    const [query, setQuery] = useState("");
    const needle = query.trim().toLocaleLowerCase();
    const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
    const filteredCasts = casts.filter((cast) => (kind === "all" || cast.kind === kind) && matches(`${castName(cast)} ${parseList(cast.aliasesJson).join(" ")}`));
    const filteredImages = kind === "all" || kind === "image" ? images.filter((ref) => matches(ref.name)) : [];
    return (
        <div className="drama-root drama-sdx-asset-menu" aria-label="搜索参考资产">
            {details}
            <Input allowClear value={query} prefix={<Search className="size-3.5" />} placeholder="搜索人物、别名、造型、场景或道具" aria-label="搜索资产" onChange={(event) => setQuery(event.target.value)} />
            <nav className="drama-sdx-asset-menu-kinds" aria-label="资产分类">
                {(["all", ...ASSET_KINDS, "image"] as const).map((value) => (
                    <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>
                        {value === "all" ? "全部" : KIND_LABEL[value]}
                    </button>
                ))}
            </nav>
            <div className="drama-sdx-asset-menu-results">
                {filteredCasts.map(renderCast)}
                {filteredImages.map(renderImage)}
                {!filteredCasts.length && !filteredImages.length ? <p className="drama-sdx-hint">没有匹配的资产，请更换关键词或从素材库添加。</p> : null}
            </div>
            <div className="drama-sdx-assets-foot">
                <small>已添加 {ids.length + images.length} 项 · 点击卡片按钮添加或移除</small>
                <Button size="small" disabled={busy} onClick={onLibrary}>
                    素材库
                </Button>
                <Button size="small" disabled={busy} onClick={onUpload}>
                    上传参考图
                </Button>
            </div>
            {voiceActions ? <div className="drama-sdx-assets-foot">{voiceActions}</div> : null}
        </div>
    );
}

function AssetCard({
    name,
    kind,
    resourceId,
    badge,
    checked,
    disabled,
    note,
    onToggle,
    onOpen,
    onPreview,
    onRaise,
    onLower,
    children,
}: {
    name: string;
    kind: string;
    resourceId?: string;
    badge?: string;
    checked: boolean;
    disabled: boolean;
    note: string;
    onToggle: () => void;
    onOpen?: () => void;
    onPreview: (image: { resourceId: string; name: string }) => void;
    onRaise?: () => void;
    onLower?: () => void;
    children?: ReactNode;
}) {
    return (
        <article className={`drama-sdx-asset ${checked ? "is-checked" : ""}`} aria-label={`${name}资产`}>
            <button
                type="button"
                className="drama-sdx-asset-thumb"
                disabled={!resourceId}
                aria-label={`放大预览${name}`}
                onClick={() => {
                    if (resourceId) onPreview({ resourceId, name });
                }}
            >
                {resourceId ? <MediaThumb resourceId={resourceId} alt={name} /> : <span>暂无{kind}图片</span>}
                {badge ? <em>{badge}</em> : null}
                {resourceId ? <ZoomIn className="drama-sdx-asset-zoom size-4" /> : null}
            </button>
            {onOpen ? (
                <button type="button" className="drama-sdx-asset-text" onClick={onOpen} aria-label={`查看${name}设定`}>
                    <b>{name}</b>
                </button>
            ) : (
                <strong className="drama-sdx-asset-text">{name}</strong>
            )}
            <small className="drama-sdx-asset-note">{note}</small>
            <div className="drama-sdx-asset-actions">
                <Button size="small" type="text" icon={checked ? <Trash2 className="size-3.5" /> : <Plus className="size-3.5" />} disabled={disabled} aria-label={checked ? `移除参考图${name}` : `添加参考图${name}`} onClick={onToggle}>
                    {checked ? "移除" : "添加"}
                </Button>
                {checked ? (
                    <>
                        <Button size="small" type="text" disabled={disabled || !onRaise} icon={<ArrowUp className="size-3.5" />} aria-label={`提前${name}`} onClick={onRaise} />
                        <Button size="small" type="text" disabled={disabled || !onLower} icon={<ArrowDown className="size-3.5" />} aria-label={`后移${name}`} onClick={onLower} />
                    </>
                ) : null}
            </div>
            {children}
        </article>
    );
}
