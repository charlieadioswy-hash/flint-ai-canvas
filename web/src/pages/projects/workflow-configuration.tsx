import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ImageIcon, Maximize2, SlidersHorizontal } from "lucide-react";
import { App, Button, Input, Select } from "antd";

import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasStylePickerModal, canvasStylePresets, userStylePreset, type CanvasStylePreset } from "@/components/canvas/canvas-style-picker-modal";
import { dramaChoiceKey, dramaResolutionAfterModelChange, dramaVideoOptionFits, dramaVideoRatioIssue, dramaVideoResolutionIssue } from "@/lib/drama/model-choice";
import { DRAMA_STYLE_CATEGORIES, filterDramaStyles, findDramaStyle, type DramaStyleCategory } from "@/lib/drama/drama-styles";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "@/lib/drama/style-limits";
import type { DramaSettings, DramaSummary } from "@/services/api/drama";
import { listStyleProfiles } from "@/services/api/style-profiles";

import { AssetSchemePicker, useAssetSchemes } from "./asset-scheme";
import { CharacterTemplatePicker } from "./character-template-picker";
import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { DramaStylePicker } from "./style-picker";
import { DramaAssetImageModels, DramaTextSteps, VideoResolutionField } from "./step-settings";
import { EpisodeDurationInput, StoryboardRules } from "./storyboard-rules";
import { resolveWorkflowConfigurationStyle, workflowConfigurationSamples } from "./workflow-configuration-preview";
import "./workflow-configuration.css";

const LANGUAGES = ["中文普通话", "粤语", "英语", "日语"];
const RATIOS = [
    { value: "9:16", label: "竖屏 9:16" },
    { value: "16:9", label: "横屏 16:9" },
    { value: "1:1", label: "方形 1:1" },
];

function styleInstructions(preset: CanvasStylePreset) {
    return [preset.prompt, preset.profile?.negativePrompt ? `禁止：${preset.profile.negativePrompt}` : ""].filter(Boolean).join("\n");
}

export type WorkflowConfigurationHandle = { focusIssue: () => void };

export function WorkflowConfiguration({
    summary,
    settings,
    onChange,
    disabled,
    styleOnly = false,
    scope = "project",
    ref,
}: {
    summary: DramaSummary;
    settings: DramaSettings;
    onChange: (settings: DramaSettings) => void;
    disabled: boolean;
    styleOnly?: boolean;
    scope?: "project" | "episode";
    ref?: Ref<WorkflowConfigurationHandle>;
}) {
    const { modal } = App.useApp();
    const catalog = useDramaModelCatalog();
    const schemes = useAssetSchemes();
    const [pickerOpen, setPickerOpen] = useState(false);
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [category, setCategory] = useState<"all" | "hot" | DramaStyleCategory>("all");
    const [custom, setCustom] = useState(false);
    const [previewImage, setPreviewImage] = useState<string>();
    const [unavailableImages, setUnavailableImages] = useState<Set<string>>(() => new Set());
    const [parametersOpen, setParametersOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const ratioField = useRef<HTMLDivElement>(null);
    const resolutionField = useRef<HTMLDivElement>(null);
    const continuityField = useRef<HTMLDivElement>(null);
    const profiles = useQuery({ queryKey: ["style-profiles"], queryFn: listStyleProfiles });
    const style = resolveWorkflowConfigurationStyle(settings.stylePrompt);
    const libraryStyle = [
        ...canvasStylePresets,
        ...(profiles.data?.profiles || []).flatMap((item) => {
            const found = userStylePreset(item);
            return found ? [found] : [];
        }),
    ].find((item) => item.title === settings.styleName && styleInstructions(item) === settings.stylePrompt);
    const image = libraryStyle?.profile ? libraryStyle.profile.coverUrl : libraryStyle?.imageUrl;
    const directImages = [...new Set([image, ...(libraryStyle?.profile?.assets.flatMap((asset) => asset.referenceUrls || []) || [])].filter((url): url is string => Boolean(url)))];
    const previewImages = directImages.length ? directImages.map((url) => ({ url, label: settings.styleName, illustrative: false })) : workflowConfigurationSamples(style);
    const imageFailed = (url: string) => setUnavailableImages((current) => new Set([...current, url]));
    const availableStyles = filterDramaStyles(category, "");
    const videoOption = catalog.data?.options.video.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(settings.models.video));
    const imageChoice = dramaChoiceKey(settings.models.characterImage) ? settings.models.characterImage : settings.models.image;
    const imageOption = catalog.data?.options.image.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(imageChoice));
    const continuity = settings.videoContinuity || "tail_frame";
    const ratioIssue = dramaVideoRatioIssue(videoOption, settings.aspectRatio);
    const resolutionIssue = dramaVideoResolutionIssue(videoOption, settings.videoResolution);
    const continuityIssue = videoOption && continuity === "tail_frame" && !videoOption.tailFrameChain ? "当前视频模型不支持尾帧续接" : "";

    useEffect(() => {
        if (styleOnly) return;
        if (ratioIssue || resolutionIssue || continuityIssue) setParametersOpen(true);
        if (continuityIssue) setAdvancedOpen(true);
    }, [styleOnly, ratioIssue, resolutionIssue, continuityIssue]);
    const locate = (field: typeof ratioField) => {
        setParametersOpen(true);
        if (field === continuityField) setAdvancedOpen(true);
        window.requestAnimationFrame(() => {
            field.current?.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            field.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')?.focus({ preventScroll: true });
        });
    };
    useImperativeHandle(ref, () => ({ focusIssue: () => locate(ratioIssue ? ratioField : resolutionIssue ? resolutionField : continuityField) }));

    const patch = (change: Partial<DramaSettings>) => {
        if (disabled) return;
        if (styleOnly) {
            onChange({
                ...settings,
                styleName: change.styleName ?? settings.styleName,
                stylePrompt: change.stylePrompt ?? settings.stylePrompt,
                assets: change.assets ?? settings.assets,
                models: { ...settings.models, ...(change.models ? { image: change.models.image, characterImage: change.models.characterImage, sceneImage: change.models.sceneImage } : {}) },
            });
            return;
        }
        onChange({ ...settings, ...change, ...(scope === "project" ? { mediaMode: "manual" } : {}) });
    };

    const selectTemplate = (kind: "character" | "scene", value: string) => {
        const current = settings.assets;
        const next = kind === "character" ? schemes.data?.schemes.find((item) => item.mode === value) : schemes.data?.sceneSchemes?.find((item) => item.id === value);
        if (!next) return;
        const prompt = "characterPrompt" in next ? next.characterPrompt : next.prompt;
        const existing = kind === "character" ? current.characterPrompt : current.scenePrompt;
        const defaults = kind === "character" ? schemes.data?.schemes.map((item) => item.characterPrompt) : [...(schemes.data?.sceneSchemes?.map((item) => item.prompt) || []), schemes.data?.scenePrompt];
        const apply = () =>
            patch({
                assets:
                    kind === "character" && "mode" in next
                        ? { ...current, mode: next.mode, characterPrompt: prompt, characterRatio: next.ratio, sourceSkillId: undefined, sourceSkillName: undefined, sourcePath: undefined }
                        : { ...current, scenePrompt: prompt },
            });
        if (existing.trim() && !defaults?.some((item) => item?.trim() === existing.trim()))
            modal.confirm({ title: "替换当前绘图模板？", content: "当前提示词有手动修改，选择模板会替换这份草稿。已有图片会保留。", okText: "使用模板", cancelText: "继续编辑", onOk: apply });
        else apply();
    };

    return (
        <section className="drama-workflow-configuration" aria-label="风格设置">
            <div className="drama-workflow-config-form thin-scrollbar">
                <fieldset disabled={disabled} inert={disabled} className="drama-workflow-drawing-fields">
                    <legend>{scope === "episode" ? "绘图配置（本集）" : "绘图配置（作品）"}</legend>
                    <label>
                        <span>绘图模型</span>
                        <DramaModelPicker capability="image" value={imageChoice} onChange={(choice) => patch({ models: { ...settings.models, image: choice, characterImage: choice, sceneImage: choice } })} />
                    </label>
                    <label>
                        <span>角色绘图模板</span>
                        <CharacterTemplatePicker value={settings.assets.mode} disabled={disabled || !schemes.data} schemes={schemes.data?.schemes || []} onChange={(value) => selectTemplate("character", value)} />
                    </label>
                    <label>
                        <span>场景绘图模板</span>
                        <Select
                            aria-label="场景绘图模板"
                            value={schemes.data?.sceneSchemes?.find((item) => item.prompt.trim() === settings.assets.scenePrompt.trim())?.id || "custom"}
                            disabled={disabled || !schemes.data}
                            options={[...(schemes.data?.sceneSchemes?.map((item) => ({ value: item.id, label: item.name })) || []), { value: "custom", label: "自定义模板", disabled: true }]}
                            onChange={(value) => selectTemplate("scene", value)}
                        />
                    </label>
                    {schemes.isError ? (
                        <Button size="small" onClick={() => void schemes.refetch()}>
                            重新读取绘图模板
                        </Button>
                    ) : null}
                    <details className="drama-workflow-more">
                        <summary>绘图模板提示词与画幅</summary>
                        <AssetSchemePicker value={settings.assets} imageModel={imageOption} layout="compact" onChange={(assets) => patch({ assets })} />
                    </details>
                </fieldset>
                <fieldset disabled={disabled} inert={disabled}>
                    <legend>绘图风格</legend>
                    <div className="drama-workflow-style-modes" role="group" aria-label="风格来源">
                        <button type="button" aria-pressed={!custom} onClick={() => setCustom(false)}>
                            预设风格
                        </button>
                        <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>
                            自定义风格
                        </button>
                    </div>
                    {custom ? (
                        <>
                            <label>
                                <span>风格名称</span>
                                <Input value={settings.styleName} maxLength={60} onChange={(event) => patch({ styleName: event.target.value })} />
                            </label>
                            <label>
                                <span>风格说明</span>
                                <Input.TextArea
                                    value={settings.stylePrompt}
                                    count={{ max: DRAMA_STYLE_PROMPT_MAX_LENGTH, show: true, strategy: (value) => Array.from(value).length }}
                                    autoSize={{ minRows: 5, maxRows: 12 }}
                                    onChange={(event) => patch({ stylePrompt: event.target.value })}
                                    placeholder="描述画面质感、色调、光线与服化道"
                                />
                            </label>
                        </>
                    ) : (
                        <>
                            <div className="drama-workflow-style-categories" role="group" aria-label="风格分类">
                                {DRAMA_STYLE_CATEGORIES.map((item) => (
                                    <button key={item.key} type="button" aria-pressed={category === item.key} onClick={() => setCategory(item.key)}>
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                            <div className="drama-workflow-style-options" role="group" aria-label="预设风格">
                                {availableStyles.map((item) => (
                                    <button key={item.id} type="button" aria-pressed={item.id === style?.id} title={item.description} onClick={() => patch({ styleName: item.name, stylePrompt: item.prompt })}>
                                        {item.cover && !unavailableImages.has(item.cover) ? (
                                            <img src={item.cover} alt="" loading="lazy" onError={() => imageFailed(item.cover!)} />
                                        ) : (
                                            <span className="drama-workflow-style-placeholder">
                                                <ImageIcon aria-hidden="true" />
                                                <span>{item.cover ? "样图不可用" : "暂无样图"}</span>
                                            </span>
                                        )}
                                        <strong>{item.name}</strong>
                                        {item.id === style?.id ? <Check className="drama-workflow-style-check" aria-hidden="true" /> : null}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    <div className="drama-workflow-style-library-actions">
                        <Button size="small" disabled={disabled} onClick={() => setPickerOpen(true)}>
                            自由组合风格
                        </Button>
                        <Button size="small" disabled={disabled} onClick={() => setLibraryOpen(true)}>
                            风格库 / 我的风格
                        </Button>
                    </div>
                </fieldset>
                <details className="drama-workflow-more" open={parametersOpen} onToggle={(event) => setParametersOpen(event.currentTarget.open)}>
                    <summary>
                        <SlidersHorizontal aria-hidden="true" /> 制作参数
                    </summary>
                    <fieldset disabled={disabled || styleOnly} inert={disabled || styleOnly}>
                        <label>
                            <span>对白语言</span>
                            <Select
                                aria-label="对白语言"
                                disabled={disabled || styleOnly}
                                value={settings.language}
                                options={[...new Set([...LANGUAGES, settings.language].filter(Boolean))].map((value) => ({ value, label: value }))}
                                onChange={(language) => patch({ language })}
                            />
                        </label>
                        <div ref={ratioField}>
                            <span>画幅</span>
                            <div className="drama-tabs" role="radiogroup" aria-label="画幅">
                                {RATIOS.map((ratio) => (
                                    <button key={ratio.value} type="button" role="radio" className="drama-tab" aria-checked={settings.aspectRatio === ratio.value} disabled={disabled || styleOnly} onClick={() => patch({ aspectRatio: ratio.value })}>
                                        {ratio.label}
                                    </button>
                                ))}
                            </div>
                            {ratioIssue ? (
                                <small role="alert">
                                    当前视频模型{ratioIssue}
                                    <Button type="link" size="small" onClick={() => locate(ratioField)}>
                                        去修改
                                    </Button>
                                </small>
                            ) : null}
                        </div>
                        <div ref={resolutionField}>
                            <span>视频分辨率</span>
                            <VideoResolutionField option={videoOption} value={settings.videoResolution} onChange={(videoResolution) => patch({ videoResolution })} />
                            {resolutionIssue ? (
                                <small role="alert">
                                    当前视频模型{resolutionIssue}
                                    <Button type="link" size="small" onClick={() => locate(resolutionField)}>
                                        去修改
                                    </Button>
                                </small>
                            ) : null}
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
                        <details className="drama-workflow-more" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                            <summary>更多参数</summary>
                            <div ref={continuityField}>
                                <label>
                                    <span>视频衔接</span>
                                    <Select
                                        aria-label="视频衔接"
                                        disabled={disabled || styleOnly}
                                        value={continuity}
                                        options={[
                                            { value: "tail_frame", label: "尾帧续接", disabled: Boolean(videoOption && !videoOption.tailFrameChain) },
                                            { value: "parallel", label: "各段独立生成" },
                                        ]}
                                        onChange={(videoContinuity) => patch({ videoContinuity })}
                                    />
                                    {continuityIssue ? (
                                        <small role="alert">
                                            {continuityIssue}，请改成各段独立生成或更换模型。
                                            <Button type="link" size="small" onClick={() => locate(continuityField)}>
                                                去修改
                                            </Button>
                                        </small>
                                    ) : null}
                                </label>
                            </div>
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
                </details>
            </div>
            <div className="drama-workflow-style-preview">
                <header>
                    <div>
                        <h2>风格预览</h2>
                        <p>{settings.styleName || "选择风格查看效果"}</p>
                    </div>
                    <span className="drama-workflow-sample-label">参考示意</span>
                </header>
                {previewImages.length ? (
                    <div className="drama-workflow-style-gallery" style={{ "--workflow-style-sample-count": Math.min(previewImages.length, 6) } as CSSProperties}>
                        {previewImages.map(({ url, label, illustrative }, index) => (
                            <button
                                key={url}
                                type="button"
                                disabled={unavailableImages.has(url)}
                                onClick={() => setPreviewImage(url)}
                                aria-label={unavailableImages.has(url) ? `${label}参考样图暂不可用` : `放大${label}参考示意 ${index + 1}`}
                                title={illustrative ? `同表现形式与题材示意：${label}` : label}
                            >
                                {unavailableImages.has(url) ? (
                                    <span className="drama-workflow-style-image-error">
                                        <ImageIcon aria-hidden="true" />
                                        样图暂不可用
                                    </span>
                                ) : (
                                    <>
                                        <img src={url} alt={`${label}参考示意 ${index + 1}`} loading={index ? "lazy" : "eager"} onError={() => imageFailed(url)} />
                                        <Maximize2 aria-hidden="true" />
                                    </>
                                )}
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="drama-workflow-style-empty">
                        <ImageIcon aria-hidden="true" />
                        <p>当前风格暂无参考样图</p>
                        <span>可在自定义风格中补充画面说明</span>
                    </div>
                )}
                <div className="drama-workflow-style-description">
                    <h3>{settings.styleName || "尚未选择风格"}</h3>
                    <p>{style?.description || libraryStyle?.description || "选择左侧风格，为角色、场景和镜头建立统一画风。"}</p>
                    {settings.stylePrompt ? (
                        <details>
                            <summary>查看完整风格说明</summary>
                            <p>{settings.stylePrompt}</p>
                        </details>
                    ) : null}
                </div>
                <p className="drama-workflow-style-caption">
                    {previewImages.some((item) => item.illustrative) ? "以上为同表现形式与题材的参考示意，不代表本作品的生成结果。" : "样图用于说明风格，生成效果以实际模型结果为准。"}
                    {summary.production.chapterCount ? `已导入 ${summary.production.chapterCount} 章。` : ""}
                </p>
            </div>
            <AppModal open={Boolean(previewImage)} title={`${settings.styleName || "风格"}参考样图`} onCancel={() => setPreviewImage(undefined)} footer={null} width="min(1100px, calc(100vw - 32px))">
                <img className="drama-workflow-style-lightbox" src={previewImage} alt={`${settings.styleName}参考样图`} />
            </AppModal>
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
