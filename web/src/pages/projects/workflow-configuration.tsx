import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon } from "lucide-react";
import { Button, Select } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasStylePickerModal, canvasStylePresets, userStylePreset, type CanvasStylePreset } from "@/components/canvas/canvas-style-picker-modal";
import { dramaChoiceKey, dramaResolutionAfterModelChange, dramaVideoOptionFits, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import { DRAMA_STYLES, findDramaStyle, styleCoverBackground } from "@/lib/drama/drama-styles";
import type { DramaSettings, DramaSummary } from "@/services/api/drama";
import { listStyleProfiles } from "@/services/api/style-profiles";

import { AssetSchemePicker } from "./asset-scheme";
import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { DramaStylePicker } from "./style-picker";
import { DramaAssetImageModels, DramaTextSteps, VideoResolutionField } from "./step-settings";
import { EpisodeDurationInput, StoryboardRules } from "./storyboard-rules";

const LANGUAGES = ["中文普通话", "粤语", "英语", "日语"];
const RATIOS = [
    { value: "9:16", label: "竖屏 9:16" },
    { value: "16:9", label: "横屏 16:9" },
    { value: "1:1", label: "方形 1:1" },
];

function styleInstructions(preset: CanvasStylePreset) {
    return [preset.prompt, preset.profile?.negativePrompt ? `禁止：${preset.profile.negativePrompt}` : ""].filter(Boolean).join("\n");
}

export function WorkflowConfiguration({ summary, settings, onChange, disabled }: { summary: DramaSummary; settings: DramaSettings; onChange: (settings: DramaSettings) => void; disabled: boolean }) {
    const catalog = useDramaModelCatalog();
    const [pickerOpen, setPickerOpen] = useState(false);
    const [libraryOpen, setLibraryOpen] = useState(false);
    const profiles = useQuery({ queryKey: ["style-profiles"], queryFn: listStyleProfiles });
    const preset = DRAMA_STYLES.find((item) => item.prompt === settings.stylePrompt && (!settings.styleName || item.name === settings.styleName));
    const style = preset ? findDramaStyle(preset.id) : undefined;
    const libraryStyle = [
        ...canvasStylePresets,
        ...(profiles.data?.profiles || []).flatMap((item) => {
            const found = userStylePreset(item);
            return found ? [found] : [];
        }),
    ].find((item) => item.title === settings.styleName && styleInstructions(item) === settings.stylePrompt);
    const image = libraryStyle?.profile ? libraryStyle.profile.coverUrl : libraryStyle?.imageUrl;
    const videoOption = catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(settings.models.video));
    const imageChoice = dramaChoiceKey(settings.models.characterImage) ? settings.models.characterImage : settings.models.image;
    const imageOption = catalog.data?.options.image.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(imageChoice));
    const continuity = settings.videoContinuity || "tail_frame";
    const ratioIssue = dramaVideoRatioIssue(videoOption, settings.aspectRatio);
    const resolutionIssue = dramaVideoResolutionIssue(videoOption, settings.videoResolution);
    const continuityIssue = videoOption && continuity === "tail_frame" && !videoOption.tailFrameChain ? "当前视频模型不支持尾帧续接" : "";

    const patch = (change: Partial<DramaSettings>) => {
        if (disabled) return;
        onChange({ ...settings, ...change, mediaMode: "manual" });
    };

    return (
        <section className="drama-workflow-configuration" aria-label="风格和基础配置">
            <div className="drama-workflow-style-preview">
                <header>
                    <h2>风格预览</h2>
                    <p>{summary.production.chapterCount ? `将用于已加入的 ${summary.production.chapterCount} 章` : "确认正文后再提取资产"}</p>
                </header>
                <div className="drama-workflow-style-cover" style={style ? { background: styleCoverBackground(style) } : undefined} role="img" aria-label={image || style?.cover ? `${settings.styleName}风格样图` : "当前风格暂无样图"}>
                    {image ? (
                        <img src={image} alt="" />
                    ) : !style?.cover ? (
                        <>
                            <ImageIcon className="size-8" aria-hidden="true" />
                            <span>{style ? "风格主色示意" : "暂无风格样图"}</span>
                        </>
                    ) : null}
                </div>
                <h3>{settings.styleName || style?.name || "尚未选择风格"}</h3>
                <p>{style?.description || settings.stylePrompt || "从右侧选择系统风格，确认后才会提取资产。"}</p>
                {settings.stylePrompt ? (
                    <details>
                        <summary>查看完整风格说明</summary>
                        <p>{settings.stylePrompt}</p>
                    </details>
                ) : null}
            </div>
            <div className="drama-workflow-config-form thin-scrollbar">
                <header>
                    <h2>基础配置</h2>
                    <p>风格、画幅和模型只在这里调整。确认前不会调用生成。</p>
                </header>
                <fieldset disabled={disabled} inert={disabled}>
                    <label>
                        <span>视觉风格</span>
                        <button type="button" disabled={disabled} onClick={() => setPickerOpen(true)}>
                            {settings.styleName || "选择风格"}
                        </button>
                    </label>
                    <Button disabled={disabled} onClick={() => setLibraryOpen(true)}>
                        从风格库选择（含我的风格）
                    </Button>
                    <label>
                        <span>对白语言</span>
                        <Select
                            aria-label="对白语言"
                            disabled={disabled}
                            value={settings.language}
                            options={[...new Set([...LANGUAGES, settings.language].filter(Boolean))].map((value) => ({ value, label: value }))}
                            onChange={(language) => patch({ language })}
                        />
                    </label>
                    <div>
                        <span>画幅</span>
                        <div className="drama-tabs" role="radiogroup" aria-label="画幅">
                            {RATIOS.map((ratio) => (
                                <button key={ratio.value} type="button" role="radio" className="drama-tab" aria-checked={settings.aspectRatio === ratio.value} disabled={disabled} onClick={() => patch({ aspectRatio: ratio.value })}>
                                    {ratio.label}
                                </button>
                            ))}
                        </div>
                        {ratioIssue ? <small role="alert">当前视频模型{ratioIssue}</small> : null}
                    </div>
                    <div>
                        <span>视频分辨率</span>
                        <VideoResolutionField option={videoOption} value={settings.videoResolution} onChange={(videoResolution) => patch({ videoResolution })} />
                        {resolutionIssue ? <small role="alert">当前视频模型{resolutionIssue}</small> : null}
                    </div>
                    <label>
                        <span>单集时长</span>
                        <EpisodeDurationInput value={settings.episodeSeconds} onChange={(episodeSeconds) => patch({ episodeSeconds })} />
                    </label>
                    {(["text", "image", "video"] as const).map((capability) => (
                        <label key={capability}>
                            <span>{capability === "text" ? "文本模型" : capability === "image" ? "图片模型" : "视频模型"}</span>
                            <DramaModelPicker
                                capability={capability}
                                value={settings.models[capability]}
                                aspectRatio={capability === "video" ? settings.aspectRatio : undefined}
                                onChange={(choice) => {
                                    const next = capability === "video" ? catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(choice)) : undefined;
                                    const continuityPatch = next && !dramaVideoOptionFits(next, settings.aspectRatio, continuity) && dramaVideoOptionFits(next, settings.aspectRatio, "parallel") ? { videoContinuity: "parallel" as const } : {};
                                    patch({ models: { ...settings.models, [capability]: choice }, ...(next ? { videoResolution: dramaResolutionAfterModelChange(next, settings.videoResolution) } : {}), ...continuityPatch });
                                }}
                            />
                        </label>
                    ))}
                    <AssetSchemePicker value={settings.assets} imageModel={imageOption} layout="compact" onChange={(assets) => patch({ assets })} />
                    <details className="drama-workflow-more">
                        <summary>更多参数</summary>
                        <label>
                            <span>视频衔接</span>
                            <Select
                                aria-label="视频衔接"
                                disabled={disabled}
                                value={continuity}
                                options={[
                                    { value: "tail_frame", label: "尾帧续接", disabled: Boolean(videoOption && !videoOption.tailFrameChain) },
                                    { value: "parallel", label: "各段独立生成" },
                                ]}
                                onChange={(videoContinuity) => patch({ videoContinuity })}
                            />
                            {continuityIssue ? <small role="alert">{continuityIssue}，请改成各段独立生成或更换模型。</small> : null}
                        </label>
                        <DramaTextSteps
                            models={settings.models}
                            onModelsChange={(change) => patch({ models: { ...settings.models, ...change } })}
                            textThinking={settings.textThinking || {}}
                            onThinkingChange={(step, level) => patch({ textThinking: { ...settings.textThinking, [step]: level === "auto" ? undefined : level } })}
                            skills={{ bible: settings.bibleSkill, script: settings.scriptSkill, prompt: settings.promptSkill }}
                            onSkillChange={(step, value) => patch({ [step === "bible" ? "bibleSkill" : step === "script" ? "scriptSkill" : "promptSkill"]: value })}
                        />
                        <StoryboardRules value={settings.storyboard} onChange={(storyboard) => patch({ storyboard })} episodeSeconds={settings.episodeSeconds} maxVideoSeconds={videoOption?.maxVideoSeconds} videoModelLabel={videoOption?.label} />
                        <DramaAssetImageModels models={settings.models} onModelsChange={(change) => patch({ models: { ...settings.models, ...change } })} assets={settings.assets} onAssetsChange={(assets) => patch({ assets })} />
                    </details>
                </fieldset>
            </div>
            <AppModal open={pickerOpen && !disabled} title="选择视觉风格" onCancel={() => setPickerOpen(false)} footer={null} width="min(960px, calc(100vw - 32px))" rootClassName="drama-root">
                <DramaStylePicker
                    value={style?.id || ""}
                    disabled={disabled}
                    onChange={(id) => {
                        const selected = findDramaStyle(id);
                        if (!selected) return;
                        patch({ styleName: selected.name, stylePrompt: selected.prompt });
                        setPickerOpen(false);
                    }}
                />
            </AppModal>
            <CanvasStylePickerModal
                open={libraryOpen && !disabled}
                value={libraryStyle?.id}
                onClose={() => setLibraryOpen(false)}
                onSelect={(selected) => {
                    patch({ styleName: selected.title, stylePrompt: styleInstructions(selected) });
                    setLibraryOpen(false);
                }}
            />
        </section>
    );
}
