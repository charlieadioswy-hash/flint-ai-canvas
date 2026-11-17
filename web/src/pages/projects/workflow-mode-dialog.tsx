import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, InputNumber, Select } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { DRAMA_STYLES } from "@/lib/drama/drama-styles";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { dramaChoiceKey, dramaResolutionAfterModelChange, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import { shotTarget } from "@/lib/drama/storyboard";
import { updateDramaSettings, type DramaSettings, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import "./workflow-mode-dialog.css";

type GenerationMode = "reference_video" | "grid_image" | "smart_director" | "storyboard";
type Props = {
    open: boolean;
    summary: DramaSummary;
    onCancel: () => void;
    onConfirm: (settings: DramaSettings) => void | Promise<unknown>;
    onGenerationStateChange?: (pending: boolean) => void;
    registerGenerationFlush?: (flush: (() => Promise<boolean>) | null) => void;
};
const MODES: Array<{ value: GenerationMode; title: string; detail: string; sequence: string[] }> = [
    { value: "reference_video", title: "参考生视频模式", detail: "以角色、场景等参考图生成视频，在镜头编辑中调整参考与提示词。", sequence: ["主体参考", "镜头视频"] },
    { value: "grid_image", title: "宫格图模式", detail: "先生成一张宫格图，再裁切为独立图片并采用到对应镜头。", sequence: ["宫格原图", "裁切分图", "镜头图片"] },
    { value: "smart_director", title: "智能导演模式", detail: "按空间、动作与反应组织分镜，结合主体参考生成视频。", sequence: ["导演分镜", "主体参考", "镜头视频"] },
    { value: "storyboard", title: "故事板模式", detail: "细化构图和动作，先生成故事板，再将所选画面用于镜头视频。", sequence: ["详细故事板", "镜头图片", "镜头视频"] },
];

export function WorkflowModeDialog(props: Props) {
    const userId = useUserStore((state) => state.user?.id || "");
    return props.open ? <WorkflowModeSession key={`${userId}:${props.summary.project.id}`} {...props} /> : null;
}

function generationConfiguration(settings: DramaSettings) {
    return { models: { image: settings.models.image, video: settings.models.video }, aspectRatio: settings.aspectRatio, videoResolution: settings.videoResolution || "", videoContinuity: settings.videoContinuity || ("tail_frame" as const) };
}

function applyGenerationConfiguration(draft: DramaSettings, saved: DramaSettings): DramaSettings {
    return { ...draft, aspectRatio: saved.aspectRatio, videoResolution: saved.videoResolution, videoContinuity: saved.videoContinuity, models: { ...draft.models, image: saved.models.image, video: saved.models.video } };
}

function WorkflowModeSession({ summary, onCancel, onConfirm, onGenerationStateChange, registerGenerationFlush }: Props) {
    const queryClient = useQueryClient();
    const operation = useDramaOperationScope(summary.project.id);
    const [draft, setDraft] = useState<DramaSettings>(() => structuredClone(summary.production.settings));
    const [revision, setRevision] = useState(summary.production.revision);
    const baseline = useRef(summary.production.settings);
    const latestDraft = useRef(draft);
    const latestSummary = useRef(summary);
    latestSummary.current = summary;
    const write = useRef<Promise<boolean> | null>(null);
    const failedGeneration = useRef("");
    const [mediaSaving, setMediaSaving] = useState(false);
    const [mediaError, setMediaError] = useState("");
    const [mode, setMode] = useState<GenerationMode>(draft.storyboard.generationMode || "reference_video");
    const [busy, setBusy] = useState(false);
    const locked = useRef(false);
    const [error, setError] = useState("");
    const catalog = useDramaModelCatalog();
    const selected = MODES.find((item) => item.value === mode)!;
    const sample = DRAMA_STYLES.find((item) => item.name === draft.styleName && item.prompt === draft.stylePrompt)?.cover || "/short-drama-styles/chinese-2d.jpg";
    const videoOptions = catalog.data?.options.video || [];
    const videoModel = videoOptions.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(draft.models.video));
    const stale = revision < summary.production.revision;
    const generationKey = JSON.stringify(generationConfiguration(draft));
    const generationDirty = generationKey !== JSON.stringify(generationConfiguration(baseline.current));
    const hasVideo = mode !== "grid_image";
    const hasImage = mode === "storyboard";
    const continuity = draft.videoContinuity || "tail_frame";
    const ratioIssue = hasVideo ? dramaVideoRatioIssue(videoModel, draft.aspectRatio) : "";
    const resolutionIssue = hasVideo ? dramaVideoResolutionIssue(videoModel, draft.videoResolution) : "";
    const continuityIssue = hasVideo && videoModel && continuity === "tail_frame" && !videoModel.tailFrameChain ? "不支持尾帧续接，请改为各段独立生成或更换模型" : "";
    const configIssue = ratioIssue || resolutionIssue || continuityIssue;
    const disabled = busy || mediaSaving || stale;
    const update = (patch: Partial<DramaSettings>) => {
        latestDraft.current = { ...latestDraft.current, ...patch };
        setDraft(latestDraft.current);
        setError("");
        if (failedGeneration.current !== JSON.stringify(generationConfiguration(latestDraft.current))) {
            failedGeneration.current = "";
            setMediaError("");
        }
    };
    const persistGeneration = () => {
        if (write.current) return write.current;
        if (JSON.stringify(generationConfiguration(latestDraft.current)) === JSON.stringify(generationConfiguration(baseline.current))) return Promise.resolve(true);
        const ticket = operation.capture();
        const target = latestDraft.current;
        setMediaSaving(true);
        setMediaError("");
        const pending = (async () => {
            try {
                if (stale) throw new Error("作品设置已有更新，请关闭后重新打开以载入最新参数。");
                const saved = await updateDramaSettings(summary.project.id, { expectedRevision: revision, generation: generationConfiguration(target) });
                if (!operation.isCurrent(ticket)) return false;
                const cached = queryClient.getQueryData<DramaSummary>(dramaKeys.summary(summary.project.id));
                if ((cached?.production.revision || 0) > saved.production.revision || latestSummary.current.production.revision > saved.production.revision) throw new Error("作品设置已有更新，请关闭后重新打开以载入最新参数。");
                baseline.current = saved.production.settings;
                latestDraft.current = applyGenerationConfiguration(latestDraft.current, saved.production.settings);
                setDraft(latestDraft.current);
                setRevision(saved.production.revision);
                failedGeneration.current = "";
                queryClient.setQueryData<DramaSummary>(dramaKeys.summary(summary.project.id), saved);
                void queryClient.invalidateQueries({ queryKey: ["drama", summary.project.id] });
                return true;
            } catch (reason) {
                if (operation.isCurrent(ticket)) {
                    failedGeneration.current = JSON.stringify(generationConfiguration(target));
                    setMediaError(reason instanceof Error ? reason.message : "生成配置未能应用，修改已保留");
                }
                return false;
            } finally {
                write.current = null;
                if (operation.isCurrent(ticket)) setMediaSaving(false);
            }
        })();
        write.current = pending;
        return pending;
    };
    const generationFlush = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
    generationFlush.current = () => (stale || configIssue ? Promise.resolve(false) : persistGeneration());
    useEffect(() => {
        registerGenerationFlush?.(() => generationFlush.current());
        return () => {
            registerGenerationFlush?.(null);
            onGenerationStateChange?.(false);
        };
    }, [registerGenerationFlush, onGenerationStateChange]);
    useEffect(() => {
        onGenerationStateChange?.(generationDirty || mediaSaving);
    }, [generationDirty, mediaSaving, onGenerationStateChange]);
    useEffect(() => {
        if (!generationDirty || disabled || configIssue || failedGeneration.current === generationKey) return;
        const timeout = window.setTimeout(() => void persistGeneration(), 350);
        return () => window.clearTimeout(timeout);
    }, [generationKey, generationDirty, disabled, configIssue]);
    const cancel = async () => {
        if (busy || locked.current) return;
        const ticket = operation.capture();
        if (stale || configIssue || (await persistGeneration())) {
            if (operation.isCurrent(ticket)) onCancel();
        }
    };
    const confirm = async () => {
        if (locked.current || busy || mediaSaving || generationDirty || stale || configIssue) return;
        const ticket = operation.capture();
        locked.current = true;
        setBusy(true);
        setError("");
        try {
            await onConfirm({ ...draft, storyboard: { ...draft.storyboard, generationMode: mode, directorTemplate: mode === "smart_director" ? "smart_drama" : mode === "storyboard" ? "storyboard_detail" : "" } });
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "保存分镜模式失败，请重试");
        } finally {
            locked.current = false;
            if (operation.isCurrent(ticket)) setBusy(false);
        }
    };
    return (
        <AppModal open centered width="min(1500px, calc(100vw - 48px))" flush title="选择分镜生成默认模式" onCancel={() => void cancel()} closable={!busy} maskClosable={!busy} footer={null}>
            <div className="drama-root drama-workflow-mode">
                <div className="drama-workflow-mode-layout">
                    <div className="drama-workflow-mode-controls thin-scrollbar">
                        <nav aria-label="分镜生成默认模式" className="drama-workflow-mode-options">
                            {MODES.map((item) => (
                                <button
                                    type="button"
                                    key={item.value}
                                    disabled={disabled}
                                    aria-pressed={mode === item.value}
                                    onClick={() => {
                                        setMode(item.value);
                                        setError("");
                                    }}
                                >
                                    <span>
                                        <strong>{item.title}</strong>
                                        <small>{item.detail}</small>
                                    </span>
                                </button>
                            ))}
                        </nav>
                        <p className="drama-workflow-mode-intro">选择后仍可在镜头编辑中调整图片、视频和参考参数。</p>
                        <section className="drama-workflow-mode-config" aria-label={`${selected.title}参数`}>
                            {mode === "grid_image" ? (
                                <div className="drama-workflow-mode-empty">
                                    <strong>当前无额外配置项</strong>
                                    <p>进入漫剧分镜后，选择本段镜头与宫格规格，查看按钮积分后点击生成原图并裁切。</p>
                                </div>
                            ) : (
                                <>
                                    <div className="drama-workflow-mode-fields">
                                        <label>
                                            <span>分镜数量</span>
                                            <Select<"smart" | "fixed">
                                                aria-label="分镜数量方式"
                                                disabled={disabled}
                                                value={draft.storyboard.shotCountMode === "fixed" ? "fixed" : "smart"}
                                                options={[
                                                    { value: "smart", label: "智能" },
                                                    { value: "fixed", label: "固定" },
                                                ]}
                                                onChange={(shotCountMode) =>
                                                    update({ storyboard: { ...draft.storyboard, shotCountMode, targetShotCount: shotCountMode === "fixed" ? shotTarget(draft.storyboard, draft.episodeSeconds) : draft.storyboard.targetShotCount } })
                                                }
                                            />
                                        </label>
                                        <label>
                                            <span>{draft.storyboard.shotCountMode === "fixed" ? "目标镜头数" : "参考镜头数"}</span>
                                            <InputNumber
                                                aria-label={draft.storyboard.shotCountMode === "fixed" ? "目标镜头数" : "参考镜头数"}
                                                disabled={disabled}
                                                min={draft.storyboard.shotCountMode === "fixed" ? 1 : 0}
                                                max={240}
                                                precision={0}
                                                placeholder={`自动估算 ${shotTarget({ ...draft.storyboard, targetShotCount: 0 }, draft.episodeSeconds)} 镜`}
                                                value={draft.storyboard.targetShotCount || undefined}
                                                onChange={(value) => update({ storyboard: { ...draft.storyboard, targetShotCount: typeof value === "number" ? value : draft.storyboard.shotCountMode === "fixed" ? 1 : 0 } })}
                                            />
                                        </label>
                                    </div>
                                    <p className="drama-workflow-mode-intro">{draft.storyboard.shotCountMode === "fixed" ? "固定模式要求生成指定数量；导入已有分镜保留原镜数。" : "镜头数仅供参考，按剧情和台词完整拆分；留空或填 0 自动估算。"}</p>
                                    {hasImage ? (
                                        <label>
                                            <span>生图模型</span>
                                            <fieldset disabled={disabled} inert={disabled}>
                                                <DramaModelPicker capability="image" value={draft.models.image} aspectRatio={draft.aspectRatio} onChange={(image) => update({ models: { ...draft.models, image } })} />
                                            </fieldset>
                                        </label>
                                    ) : null}
                                    {hasVideo ? (
                                        <label>
                                            <span>视频模型</span>
                                            <fieldset disabled={disabled} inert={disabled}>
                                                <DramaModelPicker
                                                    capability="video"
                                                    value={draft.models.video}
                                                    aspectRatio={draft.aspectRatio}
                                                    onChange={(video) => {
                                                        const next = videoOptions.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(video));
                                                        update({
                                                            models: { ...draft.models, video },
                                                            ...(next
                                                                ? { videoResolution: dramaResolutionAfterModelChange(next, draft.videoResolution), ...(continuity === "tail_frame" && !next.tailFrameChain ? { videoContinuity: "parallel" as const } : {}) }
                                                                : {}),
                                                        });
                                                    }}
                                                />
                                            </fieldset>
                                        </label>
                                    ) : null}
                                    <div className="drama-workflow-mode-fields">
                                        <label>
                                            <span>视频与生图比例</span>
                                            <Select
                                                aria-label="分镜视频与生图比例"
                                                disabled={disabled}
                                                value={draft.aspectRatio}
                                                options={[...new Set([draft.aspectRatio, ...(videoModel?.videoRatios || ["16:9", "9:16", "1:1"])])].filter(Boolean).map((value) => ({ value, label: value }))}
                                                onChange={(aspectRatio) => update({ aspectRatio })}
                                            />
                                        </label>
                                        <label>
                                            <span>视频分辨率</span>
                                            <Select
                                                aria-label="分镜视频分辨率"
                                                disabled={disabled}
                                                value={draft.videoResolution || ""}
                                                options={[
                                                    { value: "", label: "模型默认" },
                                                    ...[...new Set([draft.videoResolution, ...(videoModel?.videoResolutions || [])])].filter((value): value is string => Boolean(value)).map((value) => ({ value, label: value })),
                                                ]}
                                                onChange={(videoResolution) => update({ videoResolution })}
                                            />
                                        </label>
                                    </div>
                                    <label>
                                        <span>视频衔接</span>
                                        <Select
                                            aria-label="分镜视频衔接"
                                            disabled={disabled}
                                            value={continuity}
                                            options={[
                                                { value: "tail_frame", label: "尾帧续接", disabled: Boolean(videoModel && !videoModel.tailFrameChain) },
                                                { value: "parallel", label: "各段独立生成" },
                                            ]}
                                            onChange={(videoContinuity) => update({ videoContinuity })}
                                        />
                                    </label>
                                    {ratioIssue ? <p role="alert">当前视频模型{ratioIssue}</p> : null}
                                    {resolutionIssue ? <p role="alert">当前视频模型{resolutionIssue}</p> : null}
                                    {continuityIssue ? <p role="alert">当前视频模型{continuityIssue}</p> : null}
                                    {mode === "smart_director" || mode === "storyboard" ? <p className="drama-workflow-mode-template">分镜风格：{mode === "smart_director" ? "智能导演 · 剧集版" : "手绘故事板 · 详细分镜版"}</p> : null}
                                </>
                            )}
                            {stale ? <p role="alert">作品设置已有更新，请关闭后重新打开以载入最新参数。</p> : null}
                            {mediaError ? (
                                <p role="alert">
                                    {mediaError}
                                    {!stale ? (
                                        <Button type="link" size="small" disabled={mediaSaving} onClick={() => void persistGeneration()}>
                                            重新应用生成配置
                                        </Button>
                                    ) : null}
                                </p>
                            ) : mediaSaving || (generationDirty && !configIssue) ? (
                                <p role="status">正在应用生成配置…</p>
                            ) : null}
                            {error ? <p role="alert">{error}</p> : null}
                        </section>
                    </div>
                    <figure className={`drama-workflow-mode-preview is-${mode}`} aria-label={`${selected.title}示意`}>
                        <div className="drama-workflow-mode-art">
                            {mode === "grid_image" || mode === "storyboard" ? (
                                <div className="drama-workflow-mode-grid" aria-hidden>
                                    {Array.from({ length: mode === "grid_image" ? 4 : 6 }, (_, cell) => (
                                        <img key={cell} src={sample} alt="" style={{ objectPosition: `${cell % 2 ? 75 : 25}% ${cell > 1 ? 75 : 25}%` }} />
                                    ))}
                                </div>
                            ) : (
                                <img src={sample} alt="模式说明使用的风格参考样图" />
                            )}
                            <span>风格参考 · 模式示意</span>
                        </div>
                        <figcaption>
                            <div className="drama-workflow-mode-sequence" aria-label="制作顺序">
                                {selected.sequence.map((label, index) => (
                                    <span key={label}>
                                        <b>{String(index + 1).padStart(2, "0")}</b>
                                        {label}
                                    </span>
                                ))}
                            </div>
                            <h3>{selected.title}</h3>
                            <p>{selected.detail}</p>
                        </figcaption>
                    </figure>
                </div>
                <footer>
                    <p>图片与视频配置修改后自动生效。确认仅应用制作模式，不会生成媒体。</p>
                    <Button disabled={busy} onClick={() => void cancel()}>
                        取消
                    </Button>
                    <Button type="primary" loading={busy} disabled={stale || mediaSaving || generationDirty || Boolean(configIssue)} onClick={() => void confirm()}>
                        确认并进入漫剧分镜
                    </Button>
                </footer>
            </div>
        </AppModal>
    );
}
