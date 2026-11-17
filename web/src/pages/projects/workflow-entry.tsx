import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input, type InputRef } from "antd";
import { ArrowLeft, BookOpen, Check, ChevronRight, Clapperboard, FileText, Mic, PencilLine, ScrollText, Upload, Video } from "lucide-react";
import { useNavigate } from "react-router";

import { AppModal } from "@/components/ui/product/app-modal";
import { DEFAULT_DRAMA_STYLE_ID, findDramaStyle } from "@/lib/drama/drama-styles";
import { dramaChoiceKey, dramaVideoOptionFits } from "@/lib/drama/model-choice";
import { analyzeNovel, EPISODE_SOURCE_CHARS, sourceChars, titleFromFileName } from "@/lib/drama/novel-parse";
import { DEFAULT_STORYBOARD } from "@/lib/drama/storyboard";
import { createDrama, type DramaSettings, type DramaSourceFormat } from "@/services/api/drama";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

import { defaultAssetSettings, useAssetSchemes } from "./asset-scheme";
import { useDramaModelCatalog } from "./drama-model-picker";
import { SOURCE_FORMAT_LABEL } from "./drama-shared";
import { DRAMA_SOURCE_FILE_MAX_BYTES, formatDramaSourceFileSize, readDramaSourceFile } from "./drama-source-file";
import { WorkflowIdea } from "./workflow-idea";
import { WorkflowCanvasEntry } from "./workflow-canvas-entry";
import "./workflow.css";
import "./workflow-entry.css";

const FORMATS: Array<{ value: DramaSourceFormat; icon: typeof ScrollText }> = [
    { value: "novel", icon: ScrollText },
    { value: "script", icon: FileText },
    { value: "storyboard", icon: Clapperboard },
];
const SOURCE_START = { novel: "从小说开始", script: "从剧本开始", storyboard: "从分镜开始" };
const SOURCE_DETAIL = { novel: "上传小说，改编创作漫剧", script: "上传已有剧本创作漫剧", storyboard: "直接从分镜开始创作漫剧" };
const WORKFLOW_TITLES = ["上传剧本", "剧本格式", "风格设置", "角色场景", "漫剧分镜", "视频预览"];
const DRAMA_TYPES: Array<{ value: NonNullable<DramaSettings["dramaType"]>; label: string; detail: string; icon: typeof BookOpen; cover: string }> = [
    { value: "comic", label: "精品漫", detail: "以漫剧形式呈现故事", icon: BookOpen, cover: "/short-drama-styles/isekai-anime.jpg" },
    { value: "live_action", label: "真人剧", detail: "以真人影像形式创作", icon: Video, cover: "/short-drama-styles/urban-live-action.jpg" },
    { value: "narration", label: "漫剧解说", detail: "以旁白讲述推进故事", icon: Mic, cover: "/short-drama-styles/wuxia-swordsman.jpg" },
];
type EntryMode = "script" | "series" | "canvas";

type EntryProps = { initialFile?: File; focusInput?: boolean };

export function DramaWorkflowEntry(props: EntryProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    const fileOwner = useRef({ file: props.initialFile, userId });
    if (fileOwner.current.file !== props.initialFile) fileOwner.current = { file: props.initialFile, userId };
    return <WorkflowEntry key={userId} {...props} initialFile={fileOwner.current.userId === userId ? props.initialFile : undefined} userId={userId} />;
}

function WorkflowEntry({ initialFile, focusInput = false, userId }: EntryProps & { userId: string }) {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const entryId = useId();
    const [entryMode, setEntryMode] = useState<EntryMode>("script");
    const [sourceChooser, setSourceChooser] = useState(false);
    const [seriesSource, setSeriesSource] = useState(false);
    const [inputMode, setInputMode] = useState<"upload" | "paste">(focusInput ? "paste" : "upload");
    const [dramaType, setDramaType] = useState<NonNullable<DramaSettings["dramaType"]>>("comic");
    const [canvasLeave, setCanvasLeave] = useState(false);
    const [canvasBusy, setCanvasBusy] = useState(false);
    const canvasConfirmation = useRef<((confirmed: boolean) => void) | null>(null);
    const inputModality = useRef<"keyboard" | "pointer">("keyboard");
    const lastSourceMode = useRef<EntryMode>("script");
    const [format, setFormat] = useState<DramaSourceFormat>("novel");
    const [text, setText] = useState("");
    const [fileName, setFileName] = useState("");
    const [rename, setRename] = useState<{ name: string; error: string } | null>(null);
    const [reading, setReading] = useState(false);
    const [ideaOpen, setIdeaOpen] = useState(false);
    const [ideaState, setIdeaState] = useState({ dirty: false, busy: false });
    const [closeIdeaConfirm, setCloseIdeaConfirm] = useState(false);
    const [adoption, setAdoption] = useState<{ text: string; format: DramaSourceFormat; generation: number }>();
    const creating = useRef(false);
    const activity = useRef({ ideaState, adoption, ideaOpen });
    activity.current = { ideaState, adoption, ideaOpen };
    const fileRef = useRef<HTMLInputElement>(null);
    const textRef = useRef<TextAreaRef>(null);
    const renameInputRef = useRef<InputRef>(null);
    const mounted = useRef(false);
    const initialRead = useRef<{ file: File; promise: Promise<string> } | null>(null);
    const consumedFile = useRef<File | null>(null);
    const readGeneration = useRef(0);
    const finishedRead = useRef(0);
    const current = () => mounted.current && (useUserStore.getState().user?.id || "") === userId;
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            readGeneration.current += 1;
            // 失效旧读取时同步空闲代次，StrictMode 重放后不能留下不存在的待读取。
            finishedRead.current = readGeneration.current;
            canvasConfirmation.current?.(false);
            canvasConfirmation.current = null;
        };
    }, []);
    useEffect(() => {
        if (focusInput) textRef.current?.focus();
    }, [focusInput]);
    const catalog = useDramaModelCatalog();
    const assets = useAssetSchemes();
    const settings = useMemo(() => {
        if (!catalog.data || !assets.data) return undefined;
        const assetSettings = defaultAssetSettings(assets.data);
        if (!assetSettings) return undefined;
        const { defaults, options } = catalog.data;
        const fitting = options.video.filter((item) => dramaVideoOptionFits(item, "9:16", "tail_frame"));
        const tailVideo = fitting.find((item) => dramaChoiceKey(item.choice) === dramaChoiceKey(defaults.video)) || fitting[0];
        const parallel = options.video.find((item) => dramaVideoOptionFits(item, "9:16", "parallel"));
        const style = findDramaStyle(DEFAULT_DRAMA_STYLE_ID);
        return {
            dramaType,
            aspectRatio: "9:16",
            episodeSeconds: 90,
            language: "中文普通话",
            stylePrompt: style?.prompt || "",
            styleName: style?.name || "",
            mediaMode: "manual" as const,
            reviewMode: "sample" as const,
            videoContinuity: tailVideo ? ("tail_frame" as const) : ("parallel" as const),
            storyboard: DEFAULT_STORYBOARD,
            concurrency: 4,
            episodeMode: "chapter" as const,
            chaptersPerEpisode: 1,
            models: { ...defaults, video: tailVideo?.choice || parallel?.choice || defaults.video },
            assets: assetSettings,
        };
    }, [catalog.data, assets.data, dramaType]);
    const create = useMutation({
        mutationFn: async (name: string) => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            if (activity.current.ideaOpen || activity.current.ideaState.busy || activity.current.adoption) throw new Error("请先完成当前创意操作");
            if (readGeneration.current !== finishedRead.current) throw new Error("文件还在读取，请稍候");
            const input = text.trim();
            if (!input) throw new Error("请先上传或粘贴正文");
            if (!settings) throw new Error("默认制作配置还没准备好，请稍后重试");
            if (!name.trim()) throw new Error("请填写作品名称");
            if (Array.from(name.trim()).length > 80) throw new Error("作品名称不能超过 80 字");
            const analysis = analyzeNovel(input, { perEpisode: true });
            const chapters = analysis.chapters.map(({ title, text: chapterText }) => ({ title, text: chapterText }));
            if (!chapters.length) throw new Error("没有读取到正文");
            if (chapters.some((chapter) => sourceChars(chapter.text) > EPISODE_SOURCE_CHARS)) {
                throw new Error("单章正文超过 1.2 万字，请用章节标题拆分后再导入");
            }
            return createDrama({
                name: name.trim(),
                guided: true,
                chapters,
                settings,
                budgetMicrocredits: 0,
                start: false,
                sourceFormat: format,
                episodeMode: "chapter",
            });
        },
        onSuccess: (summary) => {
            if (!current()) return;
            setRename(null);
            void queryClient.invalidateQueries({ queryKey: ["dramas"] });
            navigate(`/projects/${summary.project.id}/guide?step=review`);
        },
        onError: (error, name) => {
            if (!current()) return;
            const errorText = error instanceof Error ? error.message : "创建失败";
            if (error instanceof ApiError && error.reason === "project_name_conflict") {
                setRename({ name, error: errorText });
            } else if (rename) {
                setRename((previous) => (previous ? { ...previous, error: errorText } : previous));
            } else {
                message.error(errorText);
            }
        },
        onSettled: () => {
            creating.current = false;
        },
    });
    const loadFile = (file: File, pending?: Promise<string>) => {
        if (!current() || creating.current || activity.current.ideaState.busy || activity.current.adoption) return;
        const generation = readGeneration.current + 1;
        readGeneration.current = generation;
        setReading(true);
        setFileName("");
        void (pending || readDramaSourceFile(file))
            .then((content) => {
                if (!current() || readGeneration.current !== generation) return;
                setText(content);
                setFileName(file.name);
                if (file === initialFile) consumedFile.current = file;
            })
            .catch((error: unknown) => {
                if (!current() || readGeneration.current !== generation) return;
                if (file === initialFile) consumedFile.current = file;
                setFileName("");
                message.error(error instanceof Error ? error.message : "文件读取失败，请重试");
            })
            .finally(() => {
                if (current() && readGeneration.current === generation) {
                    finishedRead.current = generation;
                    setReading(false);
                }
            });
    };
    useEffect(() => {
        if (!initialFile || consumedFile.current === initialFile || create.isPending || ideaState.busy || adoption) return;
        if (initialRead.current?.file !== initialFile) initialRead.current = { file: initialFile, promise: readDramaSourceFile(initialFile) };
        loadFile(initialFile, initialRead.current.promise);
    }, [initialFile, create.isPending, ideaState.busy, adoption]);
    const applyIdea = (content: string, sourceFormat: DramaSourceFormat) => {
        if (!current() || creating.current || readGeneration.current !== finishedRead.current) return;
        readGeneration.current += 1;
        finishedRead.current = readGeneration.current;
        setText(content);
        setFormat(sourceFormat);
        setInputMode("paste");
        setFileName("");
        consumedFile.current = initialFile || null;
        setAdoption(undefined);
        setIdeaOpen(false);
        setCloseIdeaConfirm(false);
    };
    const adoptIdea = (content: string, sourceFormat: DramaSourceFormat) => {
        if (!current() || !activity.current.ideaOpen || creating.current || activity.current.ideaState.busy || readGeneration.current !== finishedRead.current || !content.trim()) return;
        if (text.trim() || fileName) setAdoption({ text: content, format: sourceFormat, generation: readGeneration.current });
        else applyIdea(content, sourceFormat);
    };
    const problem = catalog.isError || assets.isError;
    const creationBlocked = create.isPending || reading || ideaState.busy || Boolean(adoption) || canvasLeave || canvasBusy;
    const sourceFrozen = creationBlocked || ideaOpen || Boolean(rename);
    const ready = Boolean(entryMode !== "canvas" && text.trim() && settings && !problem && !sourceFrozen);
    const sourcePage = entryMode === "series" && seriesSource;
    const selectedType = DRAMA_TYPES.find((item) => item.value === dramaType)!;
    const submit = () => {
        if (!creating.current && ready) {
            creating.current = true;
            create.mutate(fileName ? titleFromFileName(fileName) : text.trim().replace(/\s+/g, " ").slice(0, 24));
        }
    };
    const submitRename = () => {
        if (!rename || !current() || creationBlocked || creating.current) return;
        const name = rename.name.trim();
        if (!name || Array.from(name).length > 80) {
            setRename({ ...rename, error: !name ? "请填写作品名称" : "作品名称不能超过 80 字" });
            return;
        }
        creating.current = true;
        create.mutate(name);
    };
    const cancelRename = () => {
        if (!creating.current) setRename(null);
    };
    const closeIdea = () => {
        if (!current() || activity.current.ideaState.busy || activity.current.adoption) return;
        if (activity.current.ideaState.dirty) setCloseIdeaConfirm(true);
        else setIdeaOpen(false);
    };
    const beforeCreateCanvas = () => {
        if (!current() || creating.current || activity.current.ideaState.busy || activity.current.adoption || readGeneration.current !== finishedRead.current) return false;
        if (text.trim() || fileName || activity.current.ideaState.dirty) {
            if (canvasConfirmation.current) return false;
            setCanvasLeave(true);
            return new Promise<boolean>((resolve) => {
                canvasConfirmation.current = resolve;
            });
        }
        return true;
    };
    const confirmCanvas = (confirmed: boolean) => {
        const resolve = canvasConfirmation.current;
        canvasConfirmation.current = null;
        setCanvasLeave(false);
        if (!confirmed) setEntryMode(lastSourceMode.current);
        resolve?.(confirmed && current());
    };
    return (
        <section
            className={`drama-workflow-entry drama-entry-home${sourcePage ? " is-source-page" : ""}`}
            aria-label="导入短剧正文"
            onPointerDownCapture={(event) => {
                inputModality.current = "pointer";
                const button = (event.target as Element).closest("button");
                if (button) button.dataset.inputModality = "pointer";
            }}
            onKeyDownCapture={(event) => {
                inputModality.current = "keyboard";
                if (event.target instanceof HTMLButtonElement) event.target.dataset.inputModality = "keyboard";
            }}
            onFocusCapture={(event) => {
                if (event.target instanceof HTMLButtonElement) event.target.dataset.inputModality = inputModality.current;
            }}
        >
            <AppModal
                open={Boolean(rename)}
                title="修改作品名称"
                aria-label="修改作品名称"
                rootClassName="drama-root"
                width={440}
                centered
                footer={null}
                onCancel={cancelRename}
                closable={!create.isPending}
                maskClosable={!create.isPending}
                keyboard={!create.isPending}
                afterOpenChange={(open) => {
                    if (open) renameInputRef.current?.focus({ cursor: "all" });
                }}
            >
                {rename ? (
                    <form
                        className="drama-entry-name-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            submitRename();
                        }}
                    >
                        <p id={`${entryId}-name-hint`}>正文和制作设置已保留，修改名称后继续保存。</p>
                        <label htmlFor={`${entryId}-name`}>作品名称</label>
                        <Input
                            ref={renameInputRef}
                            id={`${entryId}-name`}
                            aria-label="新的作品名称"
                            aria-describedby={`${entryId}-name-hint${rename.error ? ` ${entryId}-name-error` : ""}`}
                            aria-invalid={Boolean(rename.error)}
                            count={{ max: 80, show: true, strategy: (value) => Array.from(value).length }}
                            value={rename.name}
                            disabled={create.isPending}
                            status={rename.error ? "error" : undefined}
                            onChange={(event) => setRename({ name: event.target.value, error: "" })}
                        />
                        {rename.error ? (
                            <p id={`${entryId}-name-error`} role="alert">
                                {rename.error}
                            </p>
                        ) : null}
                        <div className="drama-entry-name-actions">
                            <Button disabled={create.isPending} onClick={cancelRename}>
                                取消
                            </Button>
                            <Button htmlType="submit" type="primary" disabled={create.isPending || !rename.name.trim()} loading={create.isPending}>
                                继续保存
                            </Button>
                        </div>
                    </form>
                ) : null}
            </AppModal>
            <div className="drama-workflow-entry-heading" hidden={sourcePage}>
                <h2>一键生成，剧现精彩</h2>
            </div>
            <div className="drama-entry-tabs" role="tablist" aria-label="创作入口" hidden={sourcePage}>
                {(
                    [
                        ["script", "剧本"],
                        ["series", "剧集"],
                        ["canvas", "画布"],
                    ] as const
                ).map(([value, label]) => (
                    <button
                        key={value}
                        id={`${entryId}-${value}`}
                        type="button"
                        role="tab"
                        aria-selected={entryMode === value}
                        aria-controls={`${entryId}-content`}
                        disabled={sourceFrozen}
                        onClick={() => {
                            if (!current() || creating.current || sourceFrozen) return;
                            setEntryMode(value);
                            setSourceChooser(false);
                            if (value !== "canvas") lastSourceMode.current = value;
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div id={`${entryId}-content`} role="tabpanel" aria-labelledby={`${entryId}-${entryMode}`} className="drama-entry-content">
                <div className="drama-entry-types" role="radiogroup" aria-label="剧集类型" data-active={entryMode === "series" && !seriesSource} aria-hidden={entryMode !== "series" || seriesSource} inert={entryMode !== "series" || seriesSource}>
                    {DRAMA_TYPES.map(({ value, label, detail, icon: Icon }) => (
                        <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={dramaType === value}
                            disabled={sourceFrozen}
                            onClick={() => {
                                if (creating.current || sourceFrozen) return;
                                setDramaType(value);
                                setSourceChooser(true);
                            }}
                        >
                            <span className="drama-entry-type-label">{label}</span>
                            <span className="sr-only">{detail}</span>
                            <Icon className="drama-entry-type-icon" aria-hidden="true" />
                        </button>
                    ))}
                </div>
                <AppModal open={sourceChooser && entryMode === "series"} onCancel={() => setSourceChooser(false)} footer={null} title={null} width={448} centered flush className="drama-entry-source-modal" aria-label="选择创作方式">
                    <div className="drama-entry-chooser">
                        <header>
                            <img className="drama-entry-chooser-icon" src={selectedType.cover} alt="" />
                            <div>
                                <h3>{selectedType.label}</h3>
                                <p>请选择创作方式</p>
                            </div>
                        </header>
                        <div className="drama-entry-source-options">
                            {FORMATS.map(({ value }) => (
                                <button
                                    key={value}
                                    type="button"
                                    disabled={sourceFrozen}
                                    onClick={() => {
                                        if (creating.current || sourceFrozen) return;
                                        setFormat(value);
                                        setSeriesSource(true);
                                        setSourceChooser(false);
                                    }}
                                >
                                    <span>
                                        <strong>{SOURCE_START[value]}</strong>
                                        <small>{SOURCE_DETAIL[value]}</small>
                                    </span>
                                    <ChevronRight aria-hidden="true" />
                                </button>
                            ))}
                        </div>
                    </div>
                </AppModal>
                <div className="drama-entry-source" data-active={entryMode === "script" || sourcePage} aria-hidden={entryMode !== "script" && !sourcePage} inert={entryMode !== "script" && !sourcePage}>
                    {sourcePage ? (
                        <nav className="drama-entry-flow" aria-label="短剧制作步骤">
                            <ol className="drama-workflow-entry-steps">
                                {WORKFLOW_TITLES.map((step, index) => (
                                    <li key={step} aria-current={index === 0 ? "step" : undefined}>
                                        {index ? <ChevronRight aria-hidden="true" /> : null}
                                        <span>{step}</span>
                                    </li>
                                ))}
                            </ol>
                        </nav>
                    ) : null}
                    <div className="drama-entry-source-heading" hidden={!sourcePage}>
                        <Button type="text" icon={<ArrowLeft className="size-4" />} disabled={sourceFrozen} onClick={() => setSeriesSource(false)}>
                            返回
                        </Button>
                        <div>
                            <h3>{SOURCE_START[format]}</h3>
                            <p>上传符合规定格式的{SOURCE_FORMAT_LABEL[format].title}后，确认正文，进入剧本格式。</p>
                        </div>
                    </div>
                    <div className="drama-entry-import-layout">
                        <div className="drama-workflow-composer drama-entry-import">
                            <div className="drama-entry-input-actions">
                                <Button
                                    type="text"
                                    size="small"
                                    icon={inputMode === "upload" ? <PencilLine className="size-3.5" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
                                    disabled={sourceFrozen}
                                    onClick={() => setInputMode(inputMode === "upload" ? "paste" : "upload")}
                                >
                                    {inputMode === "upload" ? "手动输入 / 粘贴" : "改为上传文件"}
                                </Button>
                            </div>
                            <button
                                type="button"
                                className={`drama-entry-upload${text.trim() ? " has-file" : ""}`}
                                hidden={inputMode !== "upload"}
                                disabled={sourceFrozen}
                                onClick={() => fileRef.current?.click()}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                }}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const file = event.dataTransfer.files[0];
                                    if (file && !sourceFrozen) loadFile(file);
                                }}
                            >
                                <span className="drama-entry-upload-icon">
                                    {text.trim() ? <FileText aria-hidden="true" /> : <Upload aria-hidden="true" />}
                                    {text.trim() ? <Check className="drama-entry-upload-check" aria-hidden="true" /> : null}
                                </span>
                                <strong>{reading ? "正在读取文件…" : text.trim() ? "文件已就绪" : `上传${format === "novel" ? "小说" : SOURCE_FORMAT_LABEL[format].title}`}</strong>
                                {fileName ? <span className="drama-entry-upload-filename">{fileName}</span> : null}
                                <span>{text.trim() ? "点击或拖拽可重新上传" : "点击上传或将文件拖拽到此处"}</span>
                                <small>支持 TXT、MD、DOCX，大小 ≤ {formatDramaSourceFileSize(DRAMA_SOURCE_FILE_MAX_BYTES)}</small>
                            </button>
                            <div className="drama-entry-paste" hidden={inputMode !== "paste"}>
                                <Input.TextArea
                                    ref={textRef}
                                    value={text}
                                    disabled={sourceFrozen}
                                    onChange={(event) => {
                                        if (creating.current || activity.current.ideaState.busy || activity.current.adoption || readGeneration.current !== finishedRead.current) return;
                                        readGeneration.current += 1;
                                        finishedRead.current = readGeneration.current;
                                        setText(event.target.value);
                                        setFileName("");
                                        consumedFile.current = initialFile || null;
                                    }}
                                    autoSize={{ minRows: sourcePage ? 16 : 7, maxRows: 22 }}
                                    aria-label="短剧正文"
                                    placeholder={SOURCE_FORMAT_LABEL[format].placeholder}
                                />
                            </div>
                            <div className="drama-workflow-composer-bottom">
                                <div>
                                    <p className="drama-workflow-file-hint">{text.trim() ? `${sourceChars(text).toLocaleString()} 字 · ${selectedType.label}` : "旧版 Word（.doc）请先另存为 DOCX"}</p>
                                </div>
                                <Button type="primary" loading={create.isPending} disabled={!ready} onClick={submit}>
                                    保存并确认正文
                                </Button>
                            </div>
                        </div>
                        <aside className="drama-entry-format-help" aria-label="正文格式说明">
                            <h3>{format === "novel" ? "小说格式说明" : format === "script" ? "剧本格式说明" : "分镜格式说明"}</h3>
                            <p>按下方格式整理内容，方便识别{format === "novel" ? "章节" : "分集与场次"}。</p>
                            <h4>{format === "novel" ? "章节格式示意" : format === "script" ? "拆分单集格式示意" : "分镜表格式示意"}</h4>
                            <ol>
                                {format === "novel" ? (
                                    <>
                                        <li>以“第”字开头，“章”字结尾</li>
                                        <li>章节标题独立成行</li>
                                    </>
                                ) : format === "script" ? (
                                    <>
                                        <li>以“第”字开头，“集”字结尾</li>
                                        <li>“第X集”内部不留空格，独立成行</li>
                                        <li>X 为阿拉伯数字或汉字</li>
                                    </>
                                ) : (
                                    <>
                                        <li>标明镜头编号、画面与台词</li>
                                        <li>每个镜头独立成行</li>
                                    </>
                                )}
                            </ol>
                            <div className="drama-entry-format-example">
                                <strong>{format === "novel" ? "第三章 定一个小目标" : format === "script" ? "第3集" : "镜头1 远景"}</strong>
                                <p>
                                    {format === "novel" ? "窗外天色渐明。\n这是他醒来后的第一反应。" : format === "script" ? "3-1场 客厅 日 内\n出场角色：林晚、顾言\n△ 林晚推门而入。\n林晚：你怎么还在这里？" : "清晨，阳光穿过窗帘。\n人物推门走进房间。"}
                                </p>
                            </div>
                            {format === "script" ? (
                                <>
                                    <h4>拆分场次格式示意</h4>
                                    <ol>
                                        <li>以“集数-场次”开头</li>
                                        <li>接场景、日夜与内外景</li>
                                    </ol>
                                    <div className="drama-entry-format-example">
                                        <strong>1-2场 客厅 夜 内</strong>
                                        <p>
                                            出场角色：林晚、顾言
                                            <br />△ 门外传来敲门声。
                                        </p>
                                    </div>
                                </>
                            ) : null}
                        </aside>
                    </div>
                    <div className="drama-workflow-idea-entry">
                        <Button type="text" aria-haspopup="dialog" disabled={create.isPending || reading || ideaState.busy || Boolean(adoption)} onClick={() => setIdeaOpen(true)}>
                            一句想法生成正文（可选）
                        </Button>
                    </div>
                    {problem ? (
                        <p className="drama-workflow-notice" role="alert">
                            默认制作配置暂时无法读取。
                            <Button
                                type="link"
                                size="small"
                                onClick={() => {
                                    void catalog.refetch();
                                    void assets.refetch();
                                }}
                            >
                                重试
                            </Button>
                        </p>
                    ) : null}
                    <input
                        ref={fileRef}
                        type="file"
                        className="drama-workflow-file-input"
                        accept=".txt,.md,.markdown,.docx,text/plain,text/markdown"
                        aria-label="上传正文文件"
                        disabled={sourceFrozen}
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) loadFile(file);
                            event.target.value = "";
                        }}
                    />
                </div>
                <div className="drama-entry-canvas" data-active={entryMode === "canvas"} aria-hidden={entryMode !== "canvas"} inert={entryMode !== "canvas"}>
                    <WorkflowCanvasEntry hidden={entryMode !== "canvas"} disabled={create.isPending || reading || ideaState.busy || Boolean(adoption || rename)} onBeforeCreate={beforeCreateCanvas} onBusyChange={setCanvasBusy} />
                    {canvasLeave ? (
                        <div className="drama-entry-leave-confirm" role="region" aria-label="确认前往画布">
                            <p>正文或创意草稿尚未保存。前往画布将离开此页，是否继续？</p>
                            <Button onClick={() => confirmCanvas(false)}>继续编辑正文</Button>
                            <Button type="primary" onClick={() => confirmCanvas(true)}>
                                放弃未保存内容并前往画布
                            </Button>
                        </div>
                    ) : null}
                </div>
            </div>
            <AppModal
                title="一句想法生成正文"
                aria-label="一句想法生成正文"
                className="drama-entry-idea-modal"
                rootClassName="drama-root"
                open={ideaOpen}
                width={860}
                centered
                destroyOnHidden={false}
                footer={null}
                onCancel={closeIdea}
                closable={!ideaState.busy && !adoption}
                maskClosable={!ideaState.busy && !adoption}
                keyboard={!ideaState.busy && !adoption}
            >
                <WorkflowIdea
                    disabled={!ideaOpen || create.isPending || reading || entryMode === "canvas" || Boolean(adoption || closeIdeaConfirm || canvasLeave)}
                    onAdopt={adoptIdea}
                    onDirtyChange={(dirty, busy) => setIdeaState((previous) => (previous.dirty === dirty && previous.busy === busy ? previous : { dirty, busy }))}
                />
                {closeIdeaConfirm ? (
                    <div className="drama-workflow-idea-confirm" role="region" aria-label="确认关闭创意窗口">
                        <p>创意草稿尚未采用，关闭窗口后可再次打开继续编辑。</p>
                        <Button onClick={() => setCloseIdeaConfirm(false)}>继续创意扩写</Button>
                        <Button
                            onClick={() => {
                                setCloseIdeaConfirm(false);
                                setIdeaOpen(false);
                            }}
                        >
                            保留草稿并关闭
                        </Button>
                    </div>
                ) : null}
                {adoption ? (
                    <div className="drama-workflow-idea-confirm" role="region" aria-label="确认替换为AI正文">
                        <p>现有正文{fileName ? `（${fileName}）` : ""}将替换为这份 AI 扩写草稿；确认后仍需保存并确认正文。</p>
                        <Button onClick={() => setAdoption(undefined)}>保留现有正文</Button>
                        <Button
                            type="primary"
                            onClick={() => {
                                if (!current() || adoption.generation !== readGeneration.current) {
                                    setAdoption(undefined);
                                    return;
                                }
                                applyIdea(adoption.text, adoption.format);
                            }}
                        >
                            确认采用AI正文
                        </Button>
                    </div>
                ) : null}
            </AppModal>
        </section>
    );
}
