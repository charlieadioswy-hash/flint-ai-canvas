import { Button, Input, Popover } from "antd";
import { ArrowUpRight, ChevronDown, Download, History, ImagePlus, LoaderCircle, Plus, Scan, Sparkles, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { ImageSizePicker } from "@/components/image-size-picker";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";
import { ModelPicker } from "@/components/model-picker";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { Callout } from "@/components/ui/product/callout";
import type { ModelRequirements } from "@/lib/model-selection";
import { cn } from "@/lib/utils";
import { ScreenCreationAdvanced } from "./screen-creation-advanced";
import { ScreenCreationPreviewImage } from "./screen-creation-preview-image";
import type { ScreenCreationImage, ScreenCreationWorkspaceProps } from "./screen-creation-types";
import "./screen-creation.css";

export type { ScreenAdvancedSettings, ScreenCreationWorkspaceProps } from "./screen-creation-types";

type PreviewTab = "original" | "mask" | "result";
const previewTabs: { id: PreviewTab; label: string }[] = [
    { id: "original", label: "原始蒙版" },
    { id: "mask", label: "有效区域" },
    { id: "result", label: "生成结果" },
];
const screenModelRequirements: ModelRequirements = { capability: "image", controlNetUnits: 1 };

function ImageUpload({
    label,
    hint,
    value,
    optional = false,
    disabled,
    onUpload,
    onClear,
}: {
    label: string;
    hint: string;
    value: ScreenCreationImage | null;
    optional?: boolean;
    disabled: boolean;
    onUpload: (file: File) => void | Promise<void>;
    onClear: () => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const upload = (file: File | undefined) => {
        if (file && !disabled) void onUpload(file);
    };
    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        upload(event.dataTransfer.files[0]);
    };

    return (
        <div className="screen-creation-upload-field">
            <div className="screen-creation-field-label">
                <span>{label}</span>
                {optional ? <small>可选</small> : null}
            </div>
            <div
                className={cn("screen-creation-upload", dragging && "is-dragging", value && "has-image", disabled && "is-disabled")}
                onDragOver={(event) => {
                    event.preventDefault();
                    if (!disabled) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    aria-label={`上传${label}`}
                    className="sr-only"
                    tabIndex={-1}
                    disabled={disabled}
                    onChange={(event) => {
                        upload(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <button className="screen-creation-upload-trigger" type="button" disabled={disabled} onClick={() => inputRef.current?.click()} aria-label={value ? `更换${label}` : `上传${label}`}>
                    {value ? (
                        <span className="screen-creation-upload-thumb">
                            <ScreenCreationPreviewImage
                                storageKey={value.storageKey}
                                src={value.url}
                                alt={value.name}
                                fallback={
                                    <span role="img" aria-label={`${label}暂时无法显示`}>
                                        <Scan className="size-5" />
                                    </span>
                                }
                            />
                        </span>
                    ) : (
                        <span className="screen-creation-upload-icon">{optional ? <ImagePlus className="size-5" /> : <Upload className="size-5" />}</span>
                    )}
                    <span className="screen-creation-upload-copy">
                        <strong>{value?.name || `上传${label}`}</strong>
                        <small>{value ? [value.width && value.height ? `${value.width} × ${value.height}` : "", "点击更换"].filter(Boolean).join(" · ") : hint}</small>
                    </span>
                </button>
                {value ? <Button type="text" size="small" className="screen-creation-upload-remove" icon={<X className="size-3.5" />} aria-label={`移除${label}`} disabled={disabled} onClick={onClear} /> : null}
            </div>
        </div>
    );
}

export function ScreenCreationWorkspace(props: ScreenCreationWorkspaceProps) {
    const [previewTab, setPreviewTab] = useState<PreviewTab>(props.results.length ? "result" : "mask");
    const [historyOpen, setHistoryOpen] = useState(false);
    const [sizeOpen, setSizeOpen] = useState(false);
    const previousResultId = useRef(props.results[0]?.id);
    const previousSceneId = useRef(props.canvasId);
    const selectedResult = props.results.find((result) => result.id === props.selectedResultId) || props.results[0];
    const disabled = props.busy || props.uploading || props.loading;
    const previewUrl = previewTab === "original" ? props.mask?.url : previewTab === "mask" ? props.effectiveMaskUrl : selectedResult?.url;
    const previewStorageKey = previewTab === "original" ? props.mask?.storageKey : previewTab === "mask" ? props.effectiveMaskStorageKey : selectedResult?.storageKey;
    const previewWidth = previewTab === "result" ? selectedResult?.width : props.mask?.width;
    const previewHeight = previewTab === "result" ? selectedResult?.height : props.mask?.height;
    const hasModels = props.config.models.length > 0;

    useEffect(() => {
        const latestId = props.results[0]?.id;
        if (latestId && latestId !== previousResultId.current) setPreviewTab("result");
        if (props.canvasId !== previousSceneId.current && !latestId) setPreviewTab("mask");
        previousResultId.current = latestId;
        previousSceneId.current = props.canvasId;
    }, [props.canvasId, props.results]);

    return (
        <WorkspacePage className="screen-creation-page">
            <div className="screen-creation-page-inner">
                <PageHeader
                    title="异形屏创作"
                    description="上传屏幕蒙版，让画面贴合每一块屏。"
                    actions={
                        <>
                            <Button icon={<History className="size-4" />} onClick={() => setHistoryOpen(true)}>
                                最近场景
                            </Button>
                            <Button icon={<Plus className="size-4" />} disabled={disabled} onClick={props.newScene}>
                                新建场景
                            </Button>
                        </>
                    }
                />
                {props.loading ? (
                    <WorkspaceLoadingState label="正在打开异形屏场景" detail="读取蒙版、生成设置与历史结果" />
                ) : (
                    <div className="screen-creation-layout">
                        <section className="screen-creation-composer" aria-label="异形屏创作设置">
                            <div className="screen-creation-composer-head">
                                <span className="screen-creation-mark">
                                    <Scan className="size-4" />
                                </span>
                                <div>
                                    <h2>{props.sceneName || "开始一个屏幕场景"}</h2>
                                    <p>确定屏幕范围，再描述想呈现的画面</p>
                                </div>
                            </div>
                            <fieldset className="screen-creation-inputs" disabled={disabled}>
                                <ImageUpload label="屏幕蒙版" hint="点击或拖入 PNG、JPG" value={props.mask} disabled={disabled} onUpload={props.uploadMask} onClear={props.clearMask} />
                                <ImageUpload label="内容参考图" hint="参考画面的色彩、风格与内容" value={props.reference} optional disabled={disabled} onUpload={props.uploadReference} onClear={props.clearReference} />
                                <label className="screen-creation-field screen-creation-prompt">
                                    <span>画面描述</span>
                                    <Input.TextArea
                                        aria-label="画面描述"
                                        placeholder="描述屏幕里想呈现的主体、环境、色彩与光线…"
                                        value={props.prompt}
                                        disabled={disabled}
                                        autoSize={{ minRows: 5, maxRows: 12 }}
                                        maxLength={props.profile?.references.promptMaxChars || undefined}
                                        onChange={(event) => props.setPrompt(event.target.value)}
                                    />
                                </label>
                                <div className="screen-creation-model-settings">
                                    <div className="screen-creation-model-picker">
                                        <ModelPicker config={props.config} value={props.model} onChange={props.setModel} capability="image" requirements={screenModelRequirements} fullWidth showSelectedPrice={false} showOptionPrices variant="creation" />
                                    </div>
                                    {props.profile ? (
                                        <Popover
                                            open={sizeOpen && !disabled}
                                            onOpenChange={setSizeOpen}
                                            trigger="click"
                                            placement="bottomLeft"
                                            content={
                                                <div className="screen-creation-size-popover">
                                                    <ImageSizePicker
                                                        profile={props.profile}
                                                        size={props.size}
                                                        quality={props.quality}
                                                        onChange={(size, quality) => {
                                                            props.setSize(size, quality);
                                                            setSizeOpen(false);
                                                        }}
                                                    />
                                                </div>
                                            }
                                        >
                                            <Button disabled={disabled} aria-label="输出尺寸" aria-expanded={sizeOpen}>
                                                {props.size === "auto" ? "自动尺寸" : props.size || "输出尺寸"}
                                                <ChevronDown className="size-3" />
                                            </Button>
                                        </Popover>
                                    ) : null}
                                </div>
                                {!hasModels ? (
                                    <Callout tone="warning" title="暂无可用的异形屏模型">
                                        请联系管理员启用异形屏生图模型，再开始创作。
                                    </Callout>
                                ) : null}
                            </fieldset>
                            <ScreenCreationAdvanced
                                advanced={props.advanced}
                                setAdvanced={props.setAdvanced}
                                maskMode={props.maskMode}
                                setMaskMode={props.setMaskMode}
                                profile={props.profile}
                                config={props.config}
                                model={props.model}
                                disabled={disabled}
                            />
                            <div className="screen-creation-submit">
                                <div className="screen-creation-quote" aria-live="polite">
                                    <span>生成 1 张</span>
                                    <span>{props.quotePending ? "正在获取报价…" : props.quoteLabel || "积分以模型报价为准"}</span>
                                </div>
                                <Button type="primary" block size="large" icon={<Sparkles className="size-4" />} loading={props.busy || props.uploading} disabled={!props.canGenerate || disabled} onClick={() => void props.generate()}>
                                    {props.uploading ? "正在准备图片" : props.busy ? "正在生成" : props.generateLabel || "生成画面"}
                                </Button>
                                {props.disabledReason && hasModels && !props.busy && !props.uploading ? <p className="screen-creation-hint">{props.disabledReason}</p> : null}
                                {props.storageNotice ? (
                                    <p className="screen-creation-hint" role="status">
                                        {props.storageNotice}
                                    </p>
                                ) : null}
                            </div>
                        </section>
                        <section className="screen-creation-preview-panel" aria-label="屏幕预览">
                            <div className="screen-creation-preview-toolbar">
                                <div className="screen-creation-preview-tabs" role="group" aria-label="预览内容">
                                    {previewTabs.map((tab) => (
                                        <button key={tab.id} type="button" aria-pressed={previewTab === tab.id} className={cn(previewTab === tab.id && "is-active")} onClick={() => setPreviewTab(tab.id)}>
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>
                                {previewWidth && previewHeight ? (
                                    <span className="screen-creation-dimensions">
                                        {previewWidth} × {previewHeight}
                                    </span>
                                ) : null}
                            </div>
                            {props.error ? (
                                <Callout className="screen-creation-feedback" tone="error" title="暂时无法完成" role="alert">
                                    {props.error}
                                </Callout>
                            ) : null}
                            {props.busy || props.uploading ? (
                                <div className="screen-creation-running" role="status" aria-live="polite">
                                    <LoaderCircle className="size-4 screen-creation-spinner" />
                                    <span>{props.statusText || (props.uploading ? "正在准备图片…" : "正在生成屏幕画面…")}</span>
                                </div>
                            ) : null}
                            <div className={cn("screen-creation-preview-stage", previewUrl && "has-image")}>
                                {previewUrl ? (
                                    <ScreenCreationPreviewImage
                                        storageKey={previewStorageKey}
                                        src={previewUrl}
                                        alt={previewTab === "original" ? "原始屏幕蒙版" : previewTab === "mask" ? "有效显示区域，白色部分可见" : "异形屏生成结果"}
                                        className="screen-creation-preview-image"
                                        eager
                                        fallback={<WorkspaceState compact title="图片暂时无法显示" description={previewUrl.startsWith("blob:") && !previewStorageKey ? "请重新上传图片，再检查屏幕显示范围。" : "请重新打开场景，或尝试下载原图。"} />}
                                    />
                                ) : (
                                    <div className="screen-creation-preview-empty">
                                        <span className="screen-creation-preview-empty-icon">
                                            <Scan />
                                        </span>
                                        <h2>{previewTab === "result" ? "画面将在这里呈现" : props.mask ? "正在准备有效区域" : "先定义屏幕的形状"}</h2>
                                        <p>{previewTab === "result" ? "上传蒙版、描述画面后，开始第一次生成。" : props.mask ? "有效区域准备完成后，可以在这里检查显示范围。" : "上传一张蒙版，在这里检查原图和有效显示区域。"}</p>
                                    </div>
                                )}
                            </div>
                            <div className="screen-creation-preview-footer">
                                <p>{previewTab === "original" ? "保留原始画幅，检查屏幕布局与边界。" : previewTab === "mask" ? "白色为可见区域，黑色为屏幕外区域。" : "结果按原始比例展示，屏幕外区域保持黑色。"}</p>
                                <div>
                                    {previewTab === "result" && selectedResult ? (
                                        <Button icon={<Download className="size-3.5" />} onClick={() => void props.downloadResult(selectedResult.id)}>
                                            下载
                                        </Button>
                                    ) : null}
                                    {props.canvasId ? (
                                        <Button icon={<ArrowUpRight className="size-3.5" />} onClick={props.openCanvas}>
                                            打开完整画布
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                            {props.results.length ? (
                                <div className="screen-creation-results">
                                    <div className="screen-creation-results-heading">
                                        <h3>生成记录</h3>
                                        <span>{props.results.length} 张</span>
                                    </div>
                                    <div className="screen-creation-result-list">
                                        {props.results.map((result, index) => (
                                            <button
                                                key={result.id}
                                                type="button"
                                                className={cn("screen-creation-result", selectedResult?.id === result.id && "is-active")}
                                                aria-pressed={selectedResult?.id === result.id}
                                                aria-label={`查看生成结果 ${props.results.length - index}`}
                                                onClick={() => {
                                                    props.setSelectedResultId(result.id);
                                                    setPreviewTab("result");
                                                }}
                                            >
                                                <ScreenCreationPreviewImage storageKey={result.storageKey} src={result.url} alt={`生成结果 ${props.results.length - index}`} fallback={<Scan className="size-4" />} />
                                                <span>{props.results.length - index}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    </div>
                )}
            </div>
            <AppDrawer title="最近的异形屏场景" size={400} open={historyOpen} onClose={() => setHistoryOpen(false)}>
                {props.recentLoading ? (
                    <WorkspaceLoadingState label="正在读取最近场景" rows={1} />
                ) : props.recentScenes.length ? (
                    <div className="screen-creation-scene-list">
                        {props.recentScenes.map((scene) => (
                            <button
                                key={scene.id}
                                type="button"
                                className={cn("screen-creation-scene", scene.id === props.canvasId && "is-active")}
                                disabled={disabled}
                                onClick={() => {
                                    props.openScene(scene.id);
                                    setHistoryOpen(false);
                                }}
                            >
                                <span className="screen-creation-scene-icon">
                                    <Scan className="size-4" />
                                </span>
                                <span>
                                    <strong>{scene.name}</strong>
                                    {scene.updatedAt ? <small>{formatSceneTime(scene.updatedAt)}</small> : null}
                                </span>
                                <ArrowUpRight className="size-4" />
                            </button>
                        ))}
                    </div>
                ) : !props.recentError ? (
                    <WorkspaceState compact title="还没有异形屏场景" description="生成后的场景会保存在这里，随时继续创作。" />
                ) : null}
                {props.recentError ? (
                    <Callout tone="error" title="场景列表暂时无法读取">
                        <p>{props.recentError}</p>
                        <Button onClick={props.retryRecentScenes} loading={props.recentLoading || props.recentLoadingMore}>重试读取场景</Button>
                    </Callout>
                ) : props.recentHasMore ? (
                    <Button block disabled={disabled} loading={props.recentLoadingMore} onClick={props.loadMoreScenes}>加载更多场景</Button>
                ) : null}
            </AppDrawer>
        </WorkspacePage>
    );
}

function formatSceneTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
