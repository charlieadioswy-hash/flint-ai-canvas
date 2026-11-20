import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { App, Button, Input, InputNumber, Select } from "antd";
import { AlertTriangle, ArrowLeft, BookOpenText, ClipboardPaste, FileUp, Cpu, Play } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceErrorState, WorkspaceLoadingState } from "@/components/layout/workspace-state";
import { CanvasStylePickerModal } from "@/components/canvas/canvas-style-picker-modal";
import { defaultDramaStyleForType, findDramaStyle, type DramaStyle } from "@/lib/drama/drama-styles";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "@/lib/drama/style-limits";
import { analyzeNovel, DRAMA_REFERENCE_SOURCE_CHARS, EPISODE_GROUP_CHARS, EPISODE_SOURCE_CHARS, sourceChars, titleFromFileName } from "@/lib/drama/novel-parse";
import { groupChapterEpisodes } from "@/lib/drama/chapter-selection";
import { ApiError } from "@/services/api/request";
import { linkCanvasToDrama } from "@/services/drama-canvas";
import { dramaChoiceKey, dramaResolutionAfterModelChange, dramaVideoOptionFits, dramaVideoRatioIssue, dramaVideoResolutionIssue, dramaVideoResolutionValue } from "@/lib/drama/model-choice";
import { formatVideoResolutionLabel } from "@/lib/video-generation-options";
import { DEFAULT_STORYBOARD } from "@/lib/drama/storyboard";
import {
    createDrama,
    estimateDrama,
    getDramaDraft,
    saveDramaDraft,
    type DramaAssetSettings,
    type DramaCapability,
    type DramaEpisodeMode,
    type DramaMediaMode,
    type DramaModels,
    type DramaReviewMode,
    type DramaSettings,
    type DramaSkillRef,
    type DramaSourceFormat,
    type DramaTextThinking,
    type DramaStoryboardSettings,
    type DramaVideoContinuity,
} from "@/services/api/drama";

import { EpisodeGroupField, formatCount, formatCredits, MEDIA_MODE_LABEL, SOURCE_FORMAT_LABEL, SourceFormatPicker, VIDEO_CONTINUITY_LABEL } from "./drama-shared";
import { AssetSchemePicker, defaultAssetSettings, useAssetSchemes } from "./asset-scheme";
import { DramaModelPicker, useDramaModelCatalog } from "./drama-model-picker";
import { DramaAssetImageModels, DramaTextSteps, VideoResolutionField } from "./step-settings";
import { EpisodeDurationInput, StoryboardRules } from "./storyboard-rules";
import { DramaStylePicker } from "./style-picker";
import { DRAMA_TYPE_OPTIONS, dramaLibraryStyleInstructions, dramaPresetSettings, type DramaStyleSettings } from "./drama-style-selection";
import { readDramaSourceFile } from "./drama-source-file";
import "./drama.css";

/** 从画布“交给短剧自动制作”带来的预填内容；canvasId 是创建后要关联的原画布（已关联项目的画布不带）。 */
type DramaCreatePrefill = { name?: string; sourceFormat?: DramaSourceFormat; text: string; canvasId?: string };
const RATIOS = [
    { value: "9:16", label: "竖屏 9:16", w: 9, h: 16 },
    { value: "16:9", label: "横屏 16:9", w: 16, h: 9 },
    { value: "1:1", label: "方形 1:1", w: 12, h: 12 },
];
const LANGUAGES = ["中文普通话", "粤语", "英语", "日语"];
const REVIEW_MODES: Array<{ value: DramaReviewMode; title: string; detail: string }> = [
    { value: "sample", title: "先看样片，满意后全剧自动", detail: "先做完第 1 集成片，请你确认一次画风、角色和声线，之后所有集自动跑到成片。" },
    { value: "every", title: "每集确认提示词", detail: "每集生成视频前停下来，等你审阅各剧情段的视频提示词与参考图。" },
    { value: "auto", title: "全自动", detail: "不打断，直接从小说跑到成片，可随时在制作台修改重做。" },
];
const CAPABILITY_LABEL: Record<DramaCapability, string> = { text: "默认文本", image: "默认图片", video: "剧情段视频" };
const EPISODE_MODES: Array<{ value: DramaEpisodeMode; title: string; detail: string }> = [
    { value: "chapter", title: "按章分集", detail: "全部原文章节按顺序分集，默认每章一集，也可以每 2–12 章合成一集。单章不超过 1.2 万字。" },
    { value: "auto", title: "整本导入，自动分集", detail: "由模型按剧情把章节规划成集（可合并或拆分章节），适合一次导入整本小说；章节多时耗时更长。" },
];

export default function DramaCreatePage() {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const fileReadSequence = useRef(0);
    const fileReaderMounted = useRef(true);
    const [readingFile, setReadingFile] = useState(false);
    useEffect(() => {
        fileReaderMounted.current = true;
        return () => {
            fileReaderMounted.current = false;
        };
    }, []);
    const [dragOver, setDragOver] = useState(false);
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const [pasteMode, setPasteMode] = useState(searchParams.get("paste") === "1");
    const [pasteText, setPasteText] = useState("");
    // ?draft=<作品 ID>：回到创建页继续编辑草稿，保存时整体替换这个草稿而不是新建作品。
    const draftId = searchParams.get("draft") || "";
    const [sourceText, setSourceText] = useState("");
    const [sourceFormat, setSourceFormat] = useState<DramaSourceFormat>("novel");
    const explicitSourceFormat = useRef<DramaSourceFormat>(undefined);
    const chooseSourceFormat = (format: DramaSourceFormat) => {
        explicitSourceFormat.current = format;
        setSourceFormat(format);
    };
    // 默认按原文章节建立完整分集目录。
    const [chapterMode, setChapterMode] = useState<DramaEpisodeMode>("chapter");
    const [groupSize, setGroupSize] = useState(1);
    const episodeMode: DramaEpisodeMode = sourceFormat === "novel" ? chapterMode : "chapter";
    const perEpisode = episodeMode === "chapter";
    // 剧本与分镜每个标题就是一集；小说按章分集时可每 N 章合成一集。
    const chaptersPerEpisode = sourceFormat === "novel" && perEpisode ? groupSize : 1;
    const analysis = useMemo(() => (sourceText ? analyzeNovel(sourceText, { perEpisode, script: sourceFormat === "script", novelReference: sourceFormat !== "script" }) : null), [perEpisode, sourceFormat, sourceText]);
    const selectedIndexes = useMemo(() => analysis?.chapters.map((_, index) => index) || [], [analysis]);
    const selectedWords = useMemo(() => selectedIndexes.reduce((sum, index) => sum + (analysis?.chapters[index]?.words || 0), 0), [analysis, selectedIndexes]);
    const episodeGroups = useMemo(
        () =>
            analysis && perEpisode
                ? groupChapterEpisodes(
                      selectedIndexes.map((index) => ({ position: index, chars: sourceChars(analysis.chapters[index].text) })),
                      chaptersPerEpisode,
                  )
                : [],
        [analysis, chaptersPerEpisode, perEpisode, selectedIndexes],
    );
    const oversizedGroup = episodeGroups.find((group) => group.chars > EPISODE_GROUP_CHARS);
    // 此页可直接启动整部作品，所有章节都需要满足改编长度限制。
    const longChapters = useMemo(() => (analysis && (perEpisode || analysis.sourceFormat) ? analysis.chapters.flatMap((chapter, index) => (sourceChars(chapter.text) > EPISODE_SOURCE_CHARS ? [index] : [])) : []), [analysis, perEpisode]);
    const longSelected = longChapters.length;
    const [name, setName] = useState("");
    const [aspectRatio, setAspectRatio] = useState("9:16");
    const [episodeSeconds, setEpisodeSeconds] = useState(90);
    const [dramaType, setDramaType] = useState<DramaSettings["dramaType"]>("comic");
    const [styleSettings, setStyleSettings] = useState<DramaStyleSettings & { styleId?: string }>(() => {
        const preset = defaultDramaStyleForType("comic");
        return { ...dramaPresetSettings(preset), styleId: preset.id };
    });
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [customStyle, setCustomStyle] = useState(false);
    const [language, setLanguage] = useState(LANGUAGES[0]);
    const [reviewMode, setReviewMode] = useState<DramaReviewMode>("sample");
    // 默认先只跑文本：先看剧情、镜头、设定和段提示词对不对，再决定花钱生成参考图与视频。
    const [mediaMode, setMediaMode] = useState<DramaMediaMode>("manual");
    const [videoContinuity, setVideoContinuity] = useState<DramaVideoContinuity>("tail_frame");
    const [storyboard, setStoryboard] = useState<DramaStoryboardSettings>(DEFAULT_STORYBOARD);
    const [promptSkill, setPromptSkill] = useState<DramaSkillRef>();
    const [bibleSkill, setBibleSkill] = useState<DramaSkillRef>();
    const [scriptSkill, setScriptSkill] = useState<DramaSkillRef>();
    const [textThinking, setTextThinking] = useState<DramaTextThinking>({});
    const [videoResolution, setVideoResolution] = useState<string>();
    const [models, setModels] = useState<Partial<DramaModels>>({});
    const [budgetCredits, setBudgetCredits] = useState<number | null>(null);
    const assetCatalog = useAssetSchemes();
    const [assetDraft, setAssetDraft] = useState<DramaAssetSettings>();
    const assets = assetDraft || defaultAssetSettings(assetCatalog.data);
    const [previewIndex, setPreviewIndex] = useState(0);

    const { styleId, ...styleSnapshot } = styleSettings;
    const selectPreset = (preset: DramaStyle) => {
        setStyleSettings({ ...dramaPresetSettings(preset), styleId: preset.id });
        setCustomStyle(false);
    };
    const selectDramaType = (type: (typeof DRAMA_TYPE_OPTIONS)[number]["value"]) => {
        if (type === dramaType) return;
        setDramaType(type);
        selectPreset(defaultDramaStyleForType(type));
    };
    const catalogQuery = useDramaModelCatalog();
    const resolvedModels = useMemo<DramaModels | undefined>(() => {
        const catalog = catalogQuery.data;
        if (!catalog) return undefined;
        const { defaults } = catalog;
        // 没手动选视频模型时按当前画幅与衔接方式挑：目录默认值给不出就换第一个给得出的，都不行留空并说明原因。
        // 分辨率不参与挑选：先选模型，模型给不出旧分辨率时按模型默认出片。
        const videoOptions = catalog.options.video || [];
        const fitting = videoOptions.filter((option) => dramaVideoOptionFits(option, aspectRatio, videoContinuity));
        const video = models.video || fitting.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(defaults.video))?.choice || fitting[0]?.choice || {};
        return { ...models, text: models.text || defaults.text, image: models.image || defaults.image, video };
    }, [aspectRatio, catalogQuery.data, models, videoContinuity]);
    const videoOption = catalogQuery.data?.options.video?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(resolvedModels?.video));
    // 角色参考图用单独指定的模型，没有就用默认图片模型；参考图方案按它检查角色画幅。
    const characterImage = dramaChoiceKey(resolvedModels?.characterImage) ? resolvedModels?.characterImage : resolvedModels?.image;
    const imageOption = catalogQuery.data?.options.image?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(characterImage));
    const videoResolutionProblem = dramaVideoResolutionIssue(videoOption, videoResolution);
    // 目录已加载时把旧项目里模型给不出的分辨率换成模型默认，报价与提交用同一个有效值。
    const effectiveVideoResolution = videoResolution && catalogQuery.data ? dramaVideoResolutionValue(videoOption, videoResolution) || undefined : videoResolution;
    const missingCapabilities = (Object.keys(CAPABILITY_LABEL) as DramaCapability[]).filter((capability) => catalogQuery.data && !dramaChoiceKey(resolvedModels?.[capability]));
    // 目录里有视频模型、但没有一个能按当前画幅与衔接方式出片：说清原因，不笼统说“没有可用模型”。
    const noFittingVideo = missingCapabilities.includes("video") && Boolean(catalogQuery.data?.options.video?.length);
    const unavailableCapabilities = missingCapabilities.filter((capability) => !(capability === "video" && noFittingVideo));
    const videoRatioProblem = dramaVideoRatioIssue(videoOption, aspectRatio);
    // 服务端只在支持图生视频时下发 tailFrameChain，缺省即不支持。
    const tailFrameProblem = videoContinuity === "tail_frame" && Boolean(videoOption) && !videoOption?.tailFrameChain;
    const settings = {
        dramaType,
        aspectRatio,
        episodeSeconds,
        ...styleSnapshot,
        language,
        reviewMode,
        mediaMode,
        videoContinuity,
        storyboard,
        ...(promptSkill ? { promptSkill } : {}),
        ...(bibleSkill ? { bibleSkill } : {}),
        ...(scriptSkill ? { scriptSkill } : {}),
        ...(Object.keys(textThinking).length ? { textThinking } : {}),
        ...(effectiveVideoResolution ? { videoResolution: effectiveVideoResolution } : {}),
        concurrency: 4,
        models: resolvedModels,
        episodeMode,
        chaptersPerEpisode,
        ...(assets ? { assets } : {}),
    };
    const estimateQuery = useQuery({
        queryKey: [
            "drama-estimate",
            selectedIndexes.length,
            selectedWords,
            episodeMode,
            chaptersPerEpisode,
            episodeSeconds,
            aspectRatio,
            videoContinuity,
            JSON.stringify(storyboard),
            [assets?.resolution, assets?.propResolution, assets?.sceneResolution, assets?.characterRatio].join("|"),
            effectiveVideoResolution || "",
            JSON.stringify(resolvedModels || {}),
        ],
        queryFn: ({ signal }) => estimateDrama({ chapterCount: selectedIndexes.length, wordCount: selectedWords, settings, episodeMode }, signal),
        enabled: Boolean(analysis && resolvedModels && selectedIndexes.length),
        staleTime: 30_000,
    });
    const estimate = estimateQuery.data;
    useEffect(() => {
        if (estimate && budgetCredits === null && estimate.maxMicrocredits > 0) setBudgetCredits(Math.ceil(estimate.maxMicrocredits / 1_000_000));
    }, [estimate, budgetCredits]);

    const loadText = (text: string, fileName?: string, preferredFormat?: DramaSourceFormat) => {
        if (!fileName) {
            fileReadSequence.current += 1;
            setReadingFile(false);
        }
        const explicitFormat = preferredFormat || explicitSourceFormat.current;
        const format = explicitFormat || sourceFormat;
        const result = analyzeNovel(text, { perEpisode: format !== "novel" || chapterMode === "chapter", script: format === "script", novelReference: format !== "script" });
        if (!result.chapters.length) {
            const issue = result.issues.find(({ kind }) => kind === "invalid_export" || kind === "reference_only");
            if (issue?.kind === "reference_only") {
                setSourceFormat(format);
                setPasteMode(true);
                setPasteText(text);
            }
            message.error(issue?.message || "没有读取到正文，请检查文件内容");
            return;
        }
        setSourceFormat(explicitFormat || result.sourceFormat || format);
        setSourceText(text);
        setBudgetCredits(null);
        if (fileName && !name) setName(titleFromFileName(fileName));
        if (!fileName && !name) setName(result.chapters[0]?.title.slice(0, 20) || "未命名短剧");
    };
    const loadFile = async (file: File) => {
        const sequence = ++fileReadSequence.current;
        const isCurrent = () => fileReaderMounted.current && sequence === fileReadSequence.current;
        setReadingFile(true);
        try {
            const text = await readDramaSourceFile(file);
            if (isCurrent()) loadText(text, file.name);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : "文件读取失败，请重试");
        } finally {
            if (isCurrent()) setReadingFile(false);
        }
    };
    const routeState = location.state as { file?: File; prefill?: DramaCreatePrefill } | null;
    const handedFile = routeState?.file;
    const prefill = routeState?.prefill;
    const handedRef = useRef(false);
    // 画布分镜带过来的原画布：作品创建后关联过去，成为它的精修画布。
    const linkCanvasRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (handedRef.current || (!handedFile && !prefill?.text)) return;
        handedRef.current = true;
        if (handedFile) void loadFile(handedFile);
        else if (prefill) {
            loadText(prefill.text, undefined, prefill.sourceFormat);
            // loadText 在没有名称时会取首章标题，这里在它之后设置，以画布带来的名称为准。
            if (prefill.name?.trim()) setName(prefill.name.trim().slice(0, 80));
            linkCanvasRef.current = prefill.canvasId;
        }
        // 文件与预填内容只用于首次进入，清掉路由状态避免刷新或返回时重复解析。
        navigate(".", { replace: true, state: null });
    }, [handedFile, prefill]); // eslint-disable-line react-hooks/exhaustive-deps
    const draftQuery = useQuery({ queryKey: ["drama-draft", draftId], queryFn: ({ signal }) => getDramaDraft(draftId, signal), enabled: Boolean(draftId), staleTime: Infinity, gcTime: 0 });
    const hydratedRef = useRef("");
    useEffect(() => {
        const draft = draftQuery.data;
        if (!draft || hydratedRef.current === draft.projectId) return;
        hydratedRef.current = draft.projectId;
        const saved = draft.settings;
        setName(draft.name);
        chooseSourceFormat(draft.sourceFormat);
        if (saved.episodeMode) setChapterMode(saved.episodeMode);
        if (saved.chaptersPerEpisode) setGroupSize(saved.chaptersPerEpisode);
        if (saved.aspectRatio) setAspectRatio(saved.aspectRatio);
        if (saved.episodeSeconds) setEpisodeSeconds(saved.episodeSeconds);
        setDramaType(saved.dramaType);
        setStyleSettings({ styleId: saved.styleSelection?.presetId || draft.form.styleId, styleName: saved.styleName, stylePrompt: saved.stylePrompt, styleSelection: saved.styleSelection });
        setCustomStyle(saved.styleSelection?.mode === "custom");
        if (saved.language) setLanguage(saved.language);
        if (saved.reviewMode) setReviewMode(saved.reviewMode);
        if (saved.mediaMode) setMediaMode(saved.mediaMode);
        if (saved.videoContinuity) setVideoContinuity(saved.videoContinuity);
        if (saved.storyboard) setStoryboard(saved.storyboard);
        setPromptSkill(saved.promptSkill);
        setBibleSkill(saved.bibleSkill);
        setScriptSkill(saved.scriptSkill);
        setTextThinking(saved.textThinking || {});
        setVideoResolution(saved.videoResolution || undefined);
        if (saved.models) setModels(saved.models);
        if (saved.assets) setAssetDraft(saved.assets);
        setBudgetCredits(Math.ceil(draft.budgetMicrocredits / 1_000_000));
        setSourceText(draft.form.sourceText);
    }, [draftQuery.data]);
    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void loadFile(file);
    };

    // start=false 保存为草稿（status=draft），连同原始正文与画风一起保存，之后从作品列表回到这里继续编辑。
    const create = useMutation({
        mutationFn: (start: boolean) => {
            const input = {
                name: name.trim(),
                chapters: analysis!.chapters.map((chapter) => ({ title: chapter.title, text: chapter.text })),
                referenceText: analysis!.referenceText,
                settings: { ...settings, models: resolvedModels },
                budgetMicrocredits: Math.max(0, Math.round((budgetCredits || 0) * 1_000_000)),
                start,
                sourceFormat,
                episodeMode,
                ...(start ? {} : { draft: { sourceText, styleId } }),
            };
            return draftId ? saveDramaDraft(draftId, input) : createDrama(input);
        },
        onSuccess: async (summary, start) => {
            const canvasId = linkCanvasRef.current;
            if (canvasId) {
                linkCanvasRef.current = undefined;
                const { warning } = await linkCanvasToDrama(canvasId, summary.project.id);
                if (warning) message.warning(warning);
            }
            if (start) {
                navigate(`/projects/${summary.project.id}`, { replace: true });
                return;
            }
            message.success("已保存为草稿，可在作品列表里继续编辑");
            // 新建的草稿换成草稿地址，再次保存时替换同一个草稿而不是再建一个。
            if (!draftId) {
                hydratedRef.current = summary.project.id;
                navigate(`/projects/new?draft=${encodeURIComponent(summary.project.id)}`, { replace: true });
            }
        },
        onError: (error) => message.error(error instanceof ApiError || error instanceof Error ? error.message : "创建失败"),
    });
    const referenceTooLong = Boolean(analysis?.referenceText && sourceChars(analysis.referenceText) > DRAMA_REFERENCE_SOURCE_CHARS);
    const tooLong = longSelected > 0 || referenceTooLong || Boolean(oversizedGroup);
    // 草稿不要求模型齐全（服务端只在开工时检查），但画幅与续接方式仍会被服务端校验；分辨率给不出时按模型默认。
    let styleIssue = "";
    if (styleSettings.styleSelection?.mode === "custom") {
        if (!styleSettings.styleName.trim() || !styleSettings.stylePrompt.trim()) styleIssue = "请填写风格名称与风格说明";
        else if (sourceChars(styleSettings.stylePrompt) > DRAMA_STYLE_PROMPT_MAX_LENGTH) styleIssue = `风格说明最多可输入 ${DRAMA_STYLE_PROMPT_MAX_LENGTH} 字`;
    }
    const canSaveDraft = Boolean(analysis && selectedIndexes.length && name.trim() && resolvedModels && !styleIssue && !videoRatioProblem && !tailFrameProblem && !tooLong && !create.isPending);
    const canStart = canSaveDraft && missingCapabilities.length === 0;
    const issues = useMemo(() => {
        if (!analysis) return [];
        const list: Array<{ key: string; message: string; blocking: boolean }> = analysis.issues.filter((issue) => issue.kind !== "too_long").map((issue) => ({ key: issue.kind, message: issue.message, blocking: false }));
        const limit = `${EPISODE_SOURCE_CHARS / 10_000} 万字`;
        if (longSelected) list.push({ key: "too_long", message: `${longSelected} ${perEpisode && chaptersPerEpisode === 1 ? "集" : "章"}原文超过 ${limit}，请用“第 N 集”标题拆开`, blocking: true });
        if (referenceTooLong) list.push({ key: "reference_too_long", message: "请将作品参考资料缩短到 1.2 万字以内", blocking: true });
        return list;
    }, [analysis, chaptersPerEpisode, longChapters.length, longSelected, perEpisode, referenceTooLong]);
    const chapterItems = useMemo(
        () =>
            (analysis?.chapters || []).map((chapter, index) => ({
                key: `${index}-${chapter.title}`,
                title: chapter.title,
                words: chapter.words,
                warn: perEpisode ? sourceChars(chapter.text) > EPISODE_SOURCE_CHARS : chapter.words < 200,
            })),
        [analysis, perEpisode],
    );

    const previewChapter = analysis?.chapters[previewIndex];
    const reset = () => {
        setSourceText("");
        setPasteText("");
        setName("");
        setPreviewIndex(0);
    };

    // 刚保存的新草稿换成草稿地址时表单已在页面上，不再显示读取状态。
    if (draftId && !draftQuery.data && hydratedRef.current !== draftId) {
        return (
            <WorkspacePage fluid scroll={false}>
                {draftQuery.isError ? (
                    <WorkspaceErrorState title="草稿不可用" description={draftQuery.error instanceof Error ? draftQuery.error.message : "草稿不存在或已开始制作"} actionLabel="返回作品列表" onRetry={() => navigate("/projects")} />
                ) : (
                    <WorkspaceLoadingState label="正在打开草稿" />
                )}
            </WorkspacePage>
        );
    }

    if (!analysis) {
        return (
            <WorkspacePage fluid scroll={false}>
                <div className="drama-root drama-compose-empty">
                    <header className="drama-compose-head">
                        <Link to="/projects">
                            <Button type="text" shape="circle" icon={<ArrowLeft className="size-4" />} aria-label="返回作品列表" />
                        </Link>
                        <h1>新建短剧</h1>
                    </header>
                    <div className="drama-compose-formats">
                        <SourceFormatPicker value={sourceFormat} onChange={chooseSourceFormat} row />
                    </div>
                    <div
                        className={`drama-drop ${dragOver ? "is-over" : ""}`}
                        onDragOver={(event) => {
                            event.preventDefault();
                            setDragOver(true);
                        }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={onDrop}
                    >
                        {pasteMode ? (
                            <div className="grid w-full max-w-[860px] gap-3">
                                <Input.TextArea
                                    autoFocus
                                    value={pasteText}
                                    onChange={(event) => setPasteText(event.target.value)}
                                    placeholder={`${SOURCE_FORMAT_LABEL[sourceFormat].placeholder}\n\n包含“第一章 / 第1集 / Chapter 1”这类标题时会自动拆分；${sourceFormat === "novel" ? "" : "每个标题就是一集，"}也可以只放第 1 集，之后在制作台逐集追加。`}
                                    autoSize={{ minRows: 14, maxRows: 24 }}
                                />
                                <div className="flex justify-end gap-2">
                                    <Button onClick={() => setPasteMode(false)}>取消</Button>
                                    <Button type="primary" disabled={!pasteText.trim()} onClick={() => loadText(pasteText)}>
                                        解析正文
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <span className="drama-drop-icon">
                                    <BookOpenText className="size-7" />
                                </span>
                                <h2>拖入{SOURCE_FORMAT_LABEL[sourceFormat].title}文件，剩下的交给流水线</h2>
                                <p>
                                    支持 30MB 以内的 TXT、Markdown 和 DOCX，自动识别文字编码与“第 N 章 / 第 N 集”标题。可以只放第 1 集，做完再在制作台追加下一集；
                                    {sourceFormat === "novel" ? "引号里的对白会逐字保留为台词。" : "台词逐字保留，不会被改写。"}
                                </p>
                                <Button type="primary" size="large" loading={readingFile} icon={<FileUp className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                    选择{SOURCE_FORMAT_LABEL[sourceFormat].title}文件
                                </Button>
                                <button type="button" className="drama-link inline-flex items-center gap-1" onClick={() => setPasteMode(true)}>
                                    <ClipboardPaste className="size-3.5" />
                                    没有文件？直接粘贴
                                </button>
                                <div className="drama-drop-steps">
                                    {[sourceFormat === "storyboard" ? "导入分镜" : "解析分集", "建立角色、道具与场景", sourceFormat === "novel" ? "改编剧本与段提示词" : "拆镜与段提示词", "按剧情段生成视频", "合成成片"].map((step, index) => (
                                        <span key={step}>
                                            <b>{index + 1}</b>
                                            {step}
                                        </span>
                                    ))}
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                    className="hidden"
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (file) void loadFile(file);
                                        event.target.value = "";
                                    }}
                                />
                            </>
                        )}
                    </div>
                </div>
            </WorkspacePage>
        );
    }

    return (
        <WorkspacePage fluid scroll={false}>
            <div className="drama-root drama-compose">
                {/* 左：小说目录 */}
                <aside className="drama-compose-novel">
                    <header className="drama-compose-head">
                        <Link to="/projects">
                            <Button type="text" shape="circle" icon={<ArrowLeft className="size-4" />} aria-label="返回作品列表" />
                        </Link>
                        <h1>{draftId ? "编辑草稿" : "新建短剧"}</h1>
                        <Button size="small" type="text" className="!ml-auto" onClick={reset}>
                            换素材
                        </Button>
                    </header>
                    <div className="drama-stats">
                        <div className="drama-stat">
                            <div className="drama-stat-value">{formatCount(selectedIndexes.length)}</div>
                            <div className="drama-stat-label">{perEpisode ? "原文段落" : "原文章节"}</div>
                        </div>
                        <div className="drama-stat">
                            <div className="drama-stat-value">{formatCount(selectedWords)}</div>
                            <div className="drama-stat-label">字</div>
                        </div>
                        <div className="drama-stat">
                            <div className="drama-stat-value">{estimate && selectedIndexes.length ? `≈${estimate.episodes}` : "—"}</div>
                            <div className="drama-stat-label">集</div>
                        </div>
                    </div>
                    {issues.length || (analysis.referenceText && !referenceTooLong) ? (
                        <div className="drama-issues">
                            {issues.map((issue) => (
                                <div key={issue.key} className={`drama-issue ${issue.blocking ? "is-blocking" : ""}`} role={issue.blocking ? "alert" : undefined}>
                                    <AlertTriangle className="size-3.5" />
                                    {issue.message}
                                </div>
                            ))}
                            {analysis.referenceText && !referenceTooLong ? <p className="drama-issue">已识别作品参考资料，供角色、场景和道具提取。</p> : null}
                        </div>
                    ) : null}
                    <ChapterDirectory items={chapterItems} previewIndex={previewIndex} onPreview={setPreviewIndex} />
                </aside>

                {/* 中：风格与审阅，下方原文预览 */}
                <main className="drama-compose-main thin-scrollbar">
                    <section>
                        <div className="drama-section-title">
                            <h2>素材与分集</h2>
                            <span>{sourceFormat === "novel" ? "引号里的对白逐字保留为台词，不会被改写" : sourceFormat === "script" ? "剧本按编号标题分集，台词逐字保留" : "分镜每个标题就是一集，台词逐字保留"}</span>
                        </div>
                        <div className="grid gap-3">
                            <SourceFormatPicker value={sourceFormat} onChange={chooseSourceFormat} row />
                            {sourceFormat === "novel" ? (
                                <div className="drama-media-modes is-row is-two" role="radiogroup" aria-label="分集方式">
                                    {EPISODE_MODES.map((mode) => (
                                        <button key={mode.value} type="button" role="radio" aria-checked={chapterMode === mode.value} className="drama-media-mode" onClick={() => setChapterMode(mode.value)}>
                                            <span className="drama-radio" />
                                            <span>
                                                <strong>
                                                    {mode.title}
                                                    {mode.value === "chapter" ? <em>推荐</em> : null}
                                                </strong>
                                                <span>{mode.detail}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            {sourceFormat === "novel" && perEpisode ? (
                                <EpisodeGroupField
                                    value={groupSize}
                                    onChange={setGroupSize}
                                    chapterCount={analysis.chapters.length}
                                    error={oversizedGroup ? `${oversizedGroup.label}合计 ${formatCount(oversizedGroup.chars)} 字，每集原文不超过 ${formatCount(EPISODE_GROUP_CHARS)} 字，请减少每集章数` : undefined}
                                />
                            ) : null}
                        </div>
                    </section>
                    <section>
                        <div className="drama-section-title">
                            <h2>剧集类型</h2>
                        </div>
                        <div className="drama-media-modes is-row is-two" role="radiogroup" aria-label="剧集类型">
                            {DRAMA_TYPE_OPTIONS.map(({ value, label, detail }) => (
                                <button key={value} type="button" role="radio" aria-checked={dramaType === value} className="drama-media-mode" disabled={create.isPending} onClick={() => selectDramaType(value)}>
                                    <strong>{label}</strong>
                                    <span>{detail}</span>
                                </button>
                            ))}
                        </div>
                        {dramaType === "narration" ? <p>当前类型为解说漫，可保留或改选。</p> : null}
                    </section>
                    <DramaStylePicker
                        value={styleId || ""}
                        dramaType={dramaType}
                        disabled={create.isPending}
                        onChange={(id) => {
                            const selected = findDramaStyle(id);
                            if (selected) selectPreset(selected);
                        }}
                    />
                    <div className="drama-workflow-style-library-actions flex gap-2">
                        <Button size="small" disabled={create.isPending} onClick={() => setLibraryOpen(true)}>
                            风格库 / 我的风格
                        </Button>
                        <Button size="small" disabled={create.isPending} aria-pressed={customStyle} onClick={() => setCustomStyle((current) => !current)}>
                            自定义风格
                        </Button>
                    </div>
                    {customStyle ? (
                        <div className="grid gap-2">
                            <Input
                                aria-label="风格名称"
                                value={styleSettings.styleName}
                                maxLength={60}
                                disabled={create.isPending}
                                onChange={(event) => setStyleSettings((current) => ({ ...current, styleId: undefined, styleName: event.target.value, styleSelection: { mode: "custom" } }))}
                            />
                            <Input.TextArea
                                aria-label="风格说明"
                                value={styleSettings.stylePrompt}
                                disabled={create.isPending}
                                autoSize={{ minRows: 3, maxRows: 8 }}
                                count={{ max: DRAMA_STYLE_PROMPT_MAX_LENGTH, show: true, strategy: (value) => Array.from(value).length }}
                                onChange={(event) => setStyleSettings((current) => ({ ...current, styleId: undefined, stylePrompt: event.target.value, styleSelection: { mode: "custom" } }))}
                            />
                        </div>
                    ) : null}
                    {styleIssue ? (
                        <p className="drama-cfg-note" role="alert">
                            {styleIssue}
                        </p>
                    ) : null}
                    <CanvasStylePickerModal
                        open={libraryOpen && !create.isPending}
                        onClose={() => setLibraryOpen(false)}
                        onSelect={(preset) => {
                            setStyleSettings({ styleName: preset.title, stylePrompt: dramaLibraryStyleInstructions(preset), styleSelection: { mode: "custom" } });
                            setCustomStyle(true);
                            setLibraryOpen(false);
                        }}
                    />
                    <section>
                        <div className="drama-section-title">
                            <h2>文字步骤</h2>
                            <span>每一步可以单独设置思考意图、文本模型和写作技能；思考档位按实际使用模型归一</span>
                        </div>
                        <DramaTextSteps
                            models={resolvedModels}
                            onModelsChange={(patch) => setModels((current) => ({ ...current, ...patch }))}
                            skills={{ bible: bibleSkill, script: scriptSkill, prompt: promptSkill }}
                            onSkillChange={(step, value) => (step === "bible" ? setBibleSkill(value) : step === "script" ? setScriptSkill(value) : setPromptSkill(value))}
                            textThinking={textThinking}
                            onThinkingChange={(step, level) => setTextThinking((current) => ({ ...current, [step]: level === "auto" ? undefined : level }))}
                        />
                    </section>
                    <section>
                        <div className="drama-section-title">
                            <h2>参考图</h2>
                            <span>参考图是每个镜头保持人物一致的锚点；角色、道具、场景可以用不同的图片模型与分辨率，开工后也能在设置里改</span>
                        </div>
                        <div className="grid gap-3">
                            <DramaAssetImageModels models={resolvedModels} onModelsChange={(patch) => setModels((current) => ({ ...current, ...patch }))} assets={assets} onAssetsChange={setAssetDraft} />
                            <AssetSchemePicker value={assets} onChange={setAssetDraft} sample={{ style: styleSettings.stylePrompt, characterName: "主角", sceneName: "主场景" }} layout="compact" imageModel={imageOption} />
                        </div>
                    </section>
                    <section>
                        <div className="drama-section-title">
                            <h2>分镜规则</h2>
                            <span>决定剧情段多长、段内镜头节奏、台词密度、表演与运镜</span>
                        </div>
                        <StoryboardRules value={storyboard} onChange={setStoryboard} episodeSeconds={episodeSeconds} maxVideoSeconds={videoOption?.maxVideoSeconds} videoModelLabel={resolvedModels?.video?.label} />
                    </section>
                    <section>
                        <div className="drama-section-title">
                            <h2>审阅方式</h2>
                            <span>只在关键点打断你</span>
                        </div>
                        <div className="drama-review-modes" role="radiogroup" aria-label="审阅方式">
                            {REVIEW_MODES.map((mode) => (
                                <button key={mode.value} type="button" role="radio" aria-checked={reviewMode === mode.value} className="drama-review-mode" onClick={() => setReviewMode(mode.value)}>
                                    <span className="drama-radio" />
                                    <span>
                                        <strong>{mode.title}</strong>
                                        <span>{mode.detail}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>
                    {previewChapter ? (
                        <section className="drama-compose-preview">
                            <div className="drama-section-title">
                                <h2>{previewChapter.title}</h2>
                                <span>原文预览 · {formatCount(previewChapter.words)} 字</span>
                            </div>
                            <div className="drama-compose-text thin-scrollbar">
                                {previewChapter.text.slice(0, 6000)}
                                {previewChapter.text.length > 6000 ? "……" : ""}
                            </div>
                        </section>
                    ) : null}
                </main>

                {/* 右：作品设置与启动 */}
                <aside className="drama-compose-side">
                    <div className="drama-compose-side-scroll thin-scrollbar">
                        <label className="block">
                            <div className="drama-option-label">作品名称</div>
                            <Input size="large" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="作品名称" />
                        </label>
                        <div>
                            <div className="drama-option-label">画幅</div>
                            <div className="drama-ratio-group" role="group" aria-label="画幅">
                                {RATIOS.map((ratio) => (
                                    <button key={ratio.value} type="button" className="drama-ratio" aria-pressed={aspectRatio === ratio.value} onClick={() => setAspectRatio(ratio.value)}>
                                        <span className="drama-ratio-shape" style={{ width: ratio.w, height: ratio.h }} />
                                        {ratio.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="block">
                                <div className="drama-option-label">单集时长</div>
                                <EpisodeDurationInput value={episodeSeconds} onChange={setEpisodeSeconds} />
                            </div>
                            <label className="block">
                                <div className="drama-option-label">对白语言</div>
                                <Select className="w-full" value={language} onChange={setLanguage} options={LANGUAGES.map((value) => ({ value, label: value }))} />
                            </label>
                        </div>
                        <div>
                            <div className="drama-option-label">生成节奏</div>
                            <div className="drama-media-modes" role="radiogroup" aria-label="生成节奏">
                                {(Object.keys(MEDIA_MODE_LABEL) as DramaMediaMode[]).map((mode) => (
                                    <button key={mode} type="button" role="radio" aria-checked={mediaMode === mode} className="drama-media-mode" onClick={() => setMediaMode(mode)}>
                                        <span className="drama-radio" />
                                        <span>
                                            <strong>
                                                {MEDIA_MODE_LABEL[mode].title}
                                                {mode === "manual" ? <em>推荐</em> : null}
                                            </strong>
                                            <span>{MEDIA_MODE_LABEL[mode].detail}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <div className="drama-option-label">段落衔接</div>
                            <div className="drama-media-modes" role="radiogroup" aria-label="段落衔接">
                                {(Object.keys(VIDEO_CONTINUITY_LABEL) as DramaVideoContinuity[]).map((mode) => (
                                    <button key={mode} type="button" role="radio" aria-checked={videoContinuity === mode} className="drama-media-mode" onClick={() => setVideoContinuity(mode)}>
                                        <span className="drama-radio" />
                                        <span>
                                            <strong>{VIDEO_CONTINUITY_LABEL[mode].title}</strong>
                                            <span>{VIDEO_CONTINUITY_LABEL[mode].detail}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                            {tailFrameProblem ? (
                                <p className="drama-cfg-note" role="alert">
                                    当前视频模型不支持图生视频，无法尾帧续接；请改用并行出片或换模型。
                                </p>
                            ) : null}
                        </div>
                        <section className="drama-compose-models" aria-label="制作模型">
                            <div className="drama-compose-models-head">
                                <Cpu className="size-4 text-[var(--workspace-accent)]" />
                                <strong>制作模型</strong>
                                <span>{catalogQuery.isLoading ? "正在读取可用模型…" : "已自动选好，可按需更换"}</span>
                            </div>
                            {(Object.keys(CAPABILITY_LABEL) as DramaCapability[]).map((capability) => (
                                <div key={capability} className="drama-compose-model-row">
                                    <span>{CAPABILITY_LABEL[capability]}</span>
                                    <DramaModelPicker
                                        capability={capability}
                                        size="sm"
                                        showPrice={false}
                                        aspectRatio={aspectRatio}
                                        value={resolvedModels?.[capability]}
                                        placeholder={`选择${CAPABILITY_LABEL[capability]}模型`}
                                        onChange={(choice) => {
                                            setModels((current) => ({ ...current, [capability]: choice }));
                                            if (capability !== "video" || !catalogQuery.data) return;
                                            const next = catalogQuery.data.options.video?.find((option) => dramaChoiceKey(option.choice) === dramaChoiceKey(choice));
                                            if (!next) return;
                                            // 模型与分辨率一起更新：新模型支持就保留，不支持就回到它的默认档。
                                            setVideoResolution((current) => dramaResolutionAfterModelChange(next, current));
                                        }}
                                    />
                                </div>
                            ))}
                            <div className="drama-compose-model-row">
                                <span>视频分辨率</span>
                                <VideoResolutionField option={videoOption} value={videoResolution} onChange={setVideoResolution} />
                            </div>
                            {videoRatioProblem ? (
                                <p className="drama-cfg-note" role="alert">
                                    当前视频模型{videoRatioProblem}，请换模型或改画幅。
                                </p>
                            ) : null}
                            {videoResolutionProblem ? (
                                <p className="drama-cfg-note">
                                    当前视频模型{videoResolutionProblem}，实际按模型默认{videoOption?.defaultVideoResolution ? ` ${formatVideoResolutionLabel(videoOption.defaultVideoResolution)}` : ""}出片。
                                </p>
                            ) : null}
                            {videoOption?.generateAudio === false ? <p className="drama-cfg-note">当前视频模型不同步生成声音，剧情段视频没有对白与音效。</p> : null}
                        </section>
                        <div className="drama-field">
                            <div className="drama-field-label">
                                <span>预算上限</span>
                                <small>留空或 0 为不限，达到后自动暂停</small>
                            </div>
                            <InputNumber className="!w-full" min={0} precision={0} value={budgetCredits} onChange={(value) => setBudgetCredits(value ?? 0)} suffix="积分" aria-label="预算上限" />
                        </div>
                        {unavailableCapabilities.length ? (
                            <p className="flex items-start gap-2 text-[var(--fs-tiny)] leading-5 text-[var(--status-error)]">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                                还没有可用的{unavailableCapabilities.map((capability) => CAPABILITY_LABEL[capability]).join("、")}模型，请联系管理员在后台开通。
                            </p>
                        ) : null}
                        {noFittingVideo ? (
                            <p className="flex items-start gap-2 text-[var(--fs-tiny)] leading-5 text-[var(--status-error)]">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                                {videoContinuity === "tail_frame" ? `没有能按 ${aspectRatio} 尾帧续接出片的视频模型，请换画幅、改用并行出片或联系管理员。` : `没有能按 ${aspectRatio} 出片的视频模型，请换画幅或联系管理员。`}
                            </p>
                        ) : null}
                    </div>
                    <footer className="drama-compose-launch">
                        <div className="drama-compose-estimate">
                            <div>
                                <b>{estimate ? `${estimate.episodes} 集` : "—"}</b>
                                <span>约 {estimate?.durationMinutes ?? "—"} 分钟</span>
                            </div>
                            <div>
                                <b>{estimate ? formatCount(estimate.shots) : "—"}</b>
                                <span>镜头</span>
                            </div>
                            <div title={estimate?.priced ? `预计积分 ${formatCredits(estimate.minMicrocredits)}–${formatCredits(estimate.maxMicrocredits)}` : undefined}>
                                <b className="is-wrap">{estimate?.priced ? `${formatCredits(estimate.minMicrocredits)}–${formatCredits(estimate.maxMicrocredits)}` : "—"}</b>
                                <span>预计积分</span>
                            </div>
                        </div>
                        {mediaMode === "manual" ? (
                            <div className="text-[var(--fs-tiny)] text-foreground/50">开工只消耗文本模型费用；剧本、设定与段提示词确认后，再逐集生成参考图与视频</div>
                        ) : reviewMode === "sample" && estimate?.priced ? (
                            <div className="text-[var(--fs-tiny)] text-foreground/50">先做第 1 集样片，约 {formatCredits(estimate.sampleMicrocredits)} 积分，确认后再跑全剧</div>
                        ) : null}
                        {estimate?.note ? <div className="text-[var(--fs-micro)] text-foreground/40">{estimate.note}</div> : null}
                        <Button type="primary" size="large" block icon={<Play className="size-4" />} disabled={!canStart} loading={create.isPending && create.variables === true} onClick={() => create.mutate(true)}>
                            {mediaMode === "manual" ? "开始改编剧本与分镜" : "开始自动制作"}
                        </Button>
                        <Button size="large" block disabled={!canSaveDraft} loading={create.isPending && create.variables === false} onClick={() => create.mutate(false)}>
                            保存为草稿
                        </Button>
                    </footer>
                </aside>
            </div>
        </WorkspacePage>
    );
}

function ChapterDirectory({ items, previewIndex, onPreview }: { items: Array<{ key: string; title: string; words: number; warn: boolean }>; previewIndex: number; onPreview: (index: number) => void }) {
    const listRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => listRef.current, estimateSize: () => 34, overscan: 12 });
    return (
        <nav className="drama-chapter-pick" aria-label="原文章节目录">
            <div ref={listRef} className="drama-chapter-list thin-scrollbar">
                <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualizer.getVirtualItems().map((row) => {
                        const item = items[row.index];
                        return (
                            <button
                                key={item.key}
                                type="button"
                                className={`drama-chapter-row absolute left-0 top-0 ${item.warn ? "is-warn" : ""}`}
                                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                                aria-current={previewIndex === row.index ? "true" : undefined}
                                onClick={() => onPreview(row.index)}
                            >
                                <span className="is-num">{String(row.index + 1).padStart(3, "0")}</span>
                                <span className="truncate text-left" title={item.title}>
                                    {item.title}
                                </span>
                                <span className="is-count">{formatCount(item.words)}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </nav>
    );
}
