import { useEffect, useMemo, useRef, useState } from "react";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { Clapperboard, FileText, ScrollText, Upload } from "lucide-react";
import { useNavigate } from "react-router";

import { DEFAULT_DRAMA_STYLE_ID, findDramaStyle } from "@/lib/drama/drama-styles";
import { dramaChoiceKey, dramaVideoOptionFits } from "@/lib/drama/model-choice";
import { analyzeNovel, EPISODE_SOURCE_CHARS, sourceChars, titleFromFileName } from "@/lib/drama/novel-parse";
import { DEFAULT_STORYBOARD } from "@/lib/drama/storyboard";
import { createDrama, type DramaSourceFormat } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { defaultAssetSettings, useAssetSchemes } from "./asset-scheme";
import { useDramaModelCatalog } from "./drama-model-picker";
import { SOURCE_FORMAT_LABEL } from "./drama-shared";
import { DRAMA_SOURCE_FILE_MAX_BYTES, formatDramaSourceFileSize, readDramaSourceFile } from "./drama-source-file";
import "./workflow.css";

const FORMATS: Array<{ value: DramaSourceFormat; icon: typeof ScrollText }> = [
    { value: "novel", icon: ScrollText },
    { value: "script", icon: FileText },
    { value: "storyboard", icon: Clapperboard },
];

type EntryProps = { showSteps?: boolean; initialFile?: File; focusInput?: boolean };

export function DramaWorkflowEntry(props: EntryProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    const fileOwner = useRef({ file: props.initialFile, userId });
    if (fileOwner.current.file !== props.initialFile) fileOwner.current = { file: props.initialFile, userId };
    return <WorkflowEntry key={userId} {...props} initialFile={fileOwner.current.userId === userId ? props.initialFile : undefined} userId={userId} />;
}

function WorkflowEntry({ showSteps = false, initialFile, focusInput = false, userId }: EntryProps & { userId: string }) {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [format, setFormat] = useState<DramaSourceFormat>("novel");
    const [text, setText] = useState("");
    const [fileName, setFileName] = useState("");
    const [reading, setReading] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const textRef = useRef<TextAreaRef>(null);
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
    }, [catalog.data, assets.data]);
    const create = useMutation({
        mutationFn: async () => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            if (readGeneration.current !== finishedRead.current) throw new Error("文件还在读取，请稍候");
            const input = text.trim();
            if (!input) throw new Error("请先上传或粘贴正文");
            if (!settings) throw new Error("默认制作配置还没准备好，请稍后重试");
            const analysis = analyzeNovel(input, { perEpisode: true });
            const chapters = analysis.chapters.map(({ title, text: chapterText }) => ({ title, text: chapterText }));
            if (!chapters.length) throw new Error("没有读取到正文");
            const selected = [0];
            if (selected.some((index) => sourceChars(chapters[index].text) > EPISODE_SOURCE_CHARS)) {
                throw new Error("单章正文超过 1.2 万字，请用章节标题拆分后再导入");
            }
            return createDrama({
                name: fileName ? titleFromFileName(fileName) : input.replace(/\s+/g, " ").slice(0, 24),
                guided: true,
                chapters,
                settings,
                budgetMicrocredits: 0,
                start: false,
                sourceFormat: format,
                episodeMode: "chapter",
                selectedChapters: selected,
            });
        },
        onSuccess: (summary) => {
            if (!current()) return;
            void queryClient.invalidateQueries({ queryKey: ["dramas"] });
            navigate(`/projects/${summary.project.id}/guide`);
        },
        onError: (error) => {
            if (current()) message.error(error instanceof Error ? error.message : "创建失败");
        },
    });
    const loadFile = (file: File, pending = readDramaSourceFile(file)) => {
        const generation = readGeneration.current + 1;
        readGeneration.current = generation;
        setReading(true);
        setFileName("");
        void pending
            .then((content) => {
                if (!current() || readGeneration.current !== generation) return;
                setText(content);
                setFileName(file.name);
                if (file === initialFile) consumedFile.current = file;
            })
            .catch((error: unknown) => {
                if (!current() || readGeneration.current !== generation) return;
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
        if (!initialFile || consumedFile.current === initialFile) return;
        if (initialRead.current?.file !== initialFile) initialRead.current = { file: initialFile, promise: readDramaSourceFile(initialFile) };
        loadFile(initialFile, initialRead.current.promise);
    }, [initialFile]);
    const problem = catalog.isError || assets.isError;
    const ready = Boolean(text.trim() && settings && !problem && !reading);
    return (
        <section className="drama-workflow-entry" aria-label="导入短剧正文">
            <div className="drama-workflow-entry-heading">
                <h2>导入正文，开始短剧制作</h2>
                <p>选择小说、剧本或已有分镜。先保存草稿，章数和本次制作范围在下一步确认，不会立刻生成。</p>
            </div>
            <div className="drama-workflow-entry-formats" role="radiogroup" aria-label="素材类型">
                {FORMATS.map(({ value, icon: Icon }) => (
                    <button key={value} type="button" role="radio" aria-checked={format === value} disabled={create.isPending} onClick={() => setFormat(value)}>
                        <Icon className="size-4" aria-hidden="true" />
                        <strong>{SOURCE_FORMAT_LABEL[value].title}</strong>
                        <span>{SOURCE_FORMAT_LABEL[value].detail}</span>
                    </button>
                ))}
            </div>
            <div className="drama-workflow-composer">
                <Input.TextArea
                    ref={textRef}
                    value={text}
                    disabled={create.isPending || reading}
                    onChange={(event) => {
                        readGeneration.current += 1;
                        finishedRead.current = readGeneration.current;
                        setText(event.target.value);
                        setFileName("");
                    }}
                    autoSize={{ minRows: 6, maxRows: 14 }}
                    aria-label="短剧正文"
                    placeholder={SOURCE_FORMAT_LABEL[format].placeholder}
                />
                <div className="drama-workflow-composer-bottom">
                    <div>
                        <Button type="text" size="small" icon={<Upload className="size-4" />} loading={reading} disabled={create.isPending} onClick={() => fileRef.current?.click()}>
                            上传 TXT / MD / DOCX
                        </Button>
                        <p className="drama-workflow-file-hint">{fileName ? `已读取 ${fileName}` : `支持 TXT、MD、Markdown 和 DOCX，不超过 ${formatDramaSourceFileSize(DRAMA_SOURCE_FILE_MAX_BYTES)}。旧版 Word（.doc）请先另存为 DOCX。`}</p>
                    </div>
                    <Button type="primary" loading={create.isPending} disabled={!ready} onClick={() => create.mutate()}>
                        保存并确认正文
                    </Button>
                </div>
            </div>
            {showSteps ? (
                <ol className="drama-workflow-entry-steps">
                    {["导入正文", "确认正文与拆集", "风格和基础配置", "主体资产", "分集分镜与视频", "预览导出"].map((step) => (
                        <li key={step}>{step}</li>
                    ))}
                </ol>
            ) : null}
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
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) loadFile(file);
                    event.target.value = "";
                }}
            />
        </section>
    );
}
