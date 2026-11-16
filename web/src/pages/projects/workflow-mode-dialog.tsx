import { useRef, useState } from "react";
import { Button, InputNumber, Select } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { DRAMA_STYLES } from "@/lib/drama/drama-styles";
import { dramaChoiceKey, dramaResolutionAfterModelChange, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import type { DramaSettings, DramaSummary } from "@/services/api/drama";

import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import "./workflow-mode-dialog.css";

type GenerationMode = "reference_video" | "grid_image" | "smart_director" | "storyboard";
type Props = { open: boolean; summary: DramaSummary; onCancel: () => void; onConfirm: (settings: DramaSettings) => void | Promise<unknown> };
const MODES: Array<{ value: GenerationMode; title: string; detail: string; sequence: string[] }> = [
    { value: "reference_video", title: "参考生视频模式", detail: "以角色、场景等参考图生成视频，在镜头编辑中调整参考与提示词。", sequence: ["主体参考", "镜头视频"] },
    { value: "grid_image", title: "宫格图模式", detail: "先生成一张宫格图，再裁切为独立图片并采用到对应镜头。", sequence: ["宫格原图", "裁切分图", "镜头图片"] },
    { value: "smart_director", title: "智能导演模式", detail: "按空间、动作与反应组织分镜，结合主体参考生成视频。", sequence: ["导演分镜", "主体参考", "镜头视频"] },
    { value: "storyboard", title: "故事板模式", detail: "细化构图和动作，先生成故事板，再将所选画面用于镜头视频。", sequence: ["详细故事板", "镜头图片", "镜头视频"] },
];

export function WorkflowModeDialog(props: Props) {
    return props.open ? <WorkflowModeSession key={props.summary.project.id} {...props} /> : null;
}

function WorkflowModeSession({ summary, onCancel, onConfirm }: Props) {
    const [draft, setDraft] = useState<DramaSettings>(() => structuredClone(summary.production.settings));
    const [revision] = useState(summary.production.revision);
    const [mode, setMode] = useState<GenerationMode>(draft.storyboard.generationMode || "reference_video");
    const [busy, setBusy] = useState(false);
    const locked = useRef(false);
    const [error, setError] = useState("");
    const catalog = useDramaModelCatalog();
    const selected = MODES.find((item) => item.value === mode)!;
    const sample = DRAMA_STYLES.find((item) => item.name === draft.styleName && item.prompt === draft.stylePrompt)?.cover || "/short-drama-styles/chinese-2d.jpg";
    const videoOptions = catalog.data?.options.video || [];
    const videoModel = videoOptions.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(draft.models.video));
    const stale = revision !== summary.production.revision;
    const hasVideo = mode !== "grid_image";
    const hasImage = mode === "storyboard";
    const continuity = draft.videoContinuity || "tail_frame";
    const ratioIssue = hasVideo ? dramaVideoRatioIssue(videoModel, draft.aspectRatio) : "";
    const resolutionIssue = hasVideo ? dramaVideoResolutionIssue(videoModel, draft.videoResolution) : "";
    const continuityIssue = hasVideo && videoModel && continuity === "tail_frame" && !videoModel.tailFrameChain ? "不支持尾帧续接，请改为各段独立生成或更换模型" : "";
    const configIssue = ratioIssue || resolutionIssue || continuityIssue;
    const update = (patch: Partial<DramaSettings>) => {
        setDraft((previous) => ({ ...previous, ...patch }));
        setError("");
    };
    const confirm = async () => {
        if (locked.current || busy || stale || configIssue) return;
        locked.current = true;
        setBusy(true);
        setError("");
        try {
            await onConfirm({ ...draft, storyboard: { ...draft.storyboard, generationMode: mode, directorTemplate: mode === "smart_director" ? "smart_drama" : mode === "storyboard" ? "storyboard_detail" : "" } });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "保存分镜模式失败，请重试");
        } finally {
            locked.current = false;
            setBusy(false);
        }
    };
    return (
        <AppModal
            open
            centered
            width="min(1500px, calc(100vw - 48px))"
            flush
            title="选择分镜生成默认模式"
            onCancel={() => {
                if (!busy && !locked.current) onCancel();
            }}
            closable={!busy}
            maskClosable={!busy}
            footer={null}
        >
            <div className="drama-root drama-workflow-mode">
                <div className="drama-workflow-mode-layout">
                    <div className="drama-workflow-mode-controls thin-scrollbar">
                        <nav aria-label="分镜生成默认模式" className="drama-workflow-mode-options">
                            {MODES.map((item) => (
                                <button
                                    type="button"
                                    key={item.value}
                                    disabled={busy}
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
                                    <p>进入漫剧分镜后，在当前段选择真实镜头与宫格规格，预检后生成原图并裁切。</p>
                                </div>
                            ) : (
                                <>
                                    <div className="drama-workflow-mode-fields">
                                        <label>
                                            <span>分镜数量</span>
                                            <Select
                                                aria-label="分镜数量方式"
                                                disabled={busy}
                                                value={draft.storyboard.targetShotCount ? "custom" : "auto"}
                                                options={[
                                                    { value: "auto", label: "智能推荐" },
                                                    { value: "custom", label: "自定义" },
                                                ]}
                                                onChange={(value) => update({ storyboard: { ...draft.storyboard, targetShotCount: value === "custom" ? 24 : undefined } })}
                                            />
                                        </label>
                                        {draft.storyboard.targetShotCount ? (
                                            <label>
                                                <span>目标镜头数</span>
                                                <InputNumber
                                                    aria-label="目标镜头数"
                                                    disabled={busy}
                                                    min={1}
                                                    max={240}
                                                    precision={0}
                                                    value={draft.storyboard.targetShotCount}
                                                    onChange={(value) => update({ storyboard: { ...draft.storyboard, targetShotCount: typeof value === "number" ? value : 1 } })}
                                                />
                                            </label>
                                        ) : null}
                                    </div>
                                    {hasImage ? (
                                        <label>
                                            <span>生图模型</span>
                                            <fieldset disabled={busy} inert={busy}>
                                                <DramaModelPicker capability="image" value={draft.models.image} aspectRatio={draft.aspectRatio} onChange={(image) => update({ models: { ...draft.models, image } })} />
                                            </fieldset>
                                        </label>
                                    ) : null}
                                    {hasVideo ? (
                                        <label>
                                            <span>视频模型</span>
                                            <fieldset disabled={busy} inert={busy}>
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
                                                disabled={busy}
                                                value={draft.aspectRatio}
                                                options={[...new Set([draft.aspectRatio, ...(videoModel?.videoRatios || ["16:9", "9:16", "1:1"])])].filter(Boolean).map((value) => ({ value, label: value }))}
                                                onChange={(aspectRatio) => update({ aspectRatio })}
                                            />
                                        </label>
                                        <label>
                                            <span>视频分辨率</span>
                                            <Select
                                                aria-label="分镜视频分辨率"
                                                disabled={busy}
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
                                            disabled={busy}
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
                    <p>本次确认保存默认配置。生成任务会按实际范围预检并确认费用。</p>
                    <Button
                        disabled={busy}
                        onClick={() => {
                            if (!locked.current) onCancel();
                        }}
                    >
                        取消
                    </Button>
                    <Button type="primary" loading={busy} disabled={stale || Boolean(configIssue)} onClick={() => void confirm()}>
                        确认并进入漫剧分镜
                    </Button>
                </footer>
            </div>
        </AppModal>
    );
}
