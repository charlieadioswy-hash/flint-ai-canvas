import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { ArrowUp, FileText, Paperclip, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import { decodeNovelText } from "@/lib/canvas/canvas-document";
import { defaultChapterSelection } from "@/lib/drama/chapter-selection";
import { DEFAULT_DRAMA_STYLE_ID, findDramaStyle } from "@/lib/drama/drama-styles";
import { dramaChoiceKey, dramaVideoOptionFits } from "@/lib/drama/model-choice";
import { analyzeNovel, EPISODE_SOURCE_CHARS, sourceChars, titleFromFileName } from "@/lib/drama/novel-parse";
import { DEFAULT_STORYBOARD } from "@/lib/drama/storyboard";
import { createDrama } from "@/services/api/drama";

import { defaultAssetSettings, useAssetSchemes } from "./asset-scheme";
import { useDramaModelCatalog } from "./drama-model-picker";
import "./guide.css";

const PIPELINE = ["解析章节", "建立角色、道具与场景", "分集改编与段提示词", "按剧情段生成视频", "合成成片"];

export function DramaGuideEntry({ showSteps = false }: { showSteps?: boolean }) {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [mode, setMode] = useState<"brief" | "source">("brief");
    const [text, setText] = useState("");
    const [fileName, setFileName] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);
    const catalog = useDramaModelCatalog();
    const assets = useAssetSchemes();
    const settings = useMemo(() => {
        if (!catalog.data) return undefined;
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
            assets: defaultAssetSettings(assets.data),
        };
    }, [catalog.data, assets.data]);
    const create = useMutation({
        mutationFn: async () => {
            const input = text.trim();
            if (!input || !settings) throw new Error("请先写下创作想法或正文");
            const chapters = mode === "source" ? analyzeNovel(input, { perEpisode: true }).chapters.map(({ title, text }) => ({ title, text })) : [];
            if (mode === "source" && !chapters.length) throw new Error("没有读取到正文");
            const selected = [...defaultChapterSelection(chapters.length)];
            if (selected.some((index) => sourceChars(chapters[index].text) > EPISODE_SOURCE_CHARS)) throw new Error("单集正文超过 1.2 万字，请用章节标题拆分，或使用原上传入口选择章节");
            return createDrama({
                name: fileName ? titleFromFileName(fileName) : input.replace(/\s+/g, " ").slice(0, 24),
                guided: true,
                brief: mode === "brief" ? input : undefined,
                chapters,
                settings,
                budgetMicrocredits: 0,
                start: false,
                sourceFormat: "novel",
                episodeMode: "chapter",
                ...(mode === "source" && selected.length < chapters.length ? { selectedChapters: selected } : {}),
            });
        },
        onSuccess: (summary) => {
            void queryClient.invalidateQueries({ queryKey: ["dramas"] });
            navigate(`/projects/${summary.project.id}/guide`);
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "创建失败"),
    });
    const loadFile = async (file: File) => {
        if (!/\.(txt|md|markdown)$/i.test(file.name)) {
            message.warning("目前支持 TXT 与 Markdown 文件");
            return;
        }
        if (file.size > 40 * 1024 * 1024) {
            message.warning("文件超过 40MB，请拆分后上传");
            return;
        }
        try {
            setText(decodeNovelText(await file.arrayBuffer()));
            setMode("source");
            setFileName(file.name);
        } catch {
            message.error("文件读取失败，请重试");
        }
    };
    const problem = catalog.isError || assets.isError;
    return (
        <section className="drama-guide-entry" aria-label="Agent 引导创作">
            <div className="drama-guide-entry-heading">
                <span className="drama-chip">
                    <Sparkles className="size-3.5" />
                    短剧创作 Agent
                </span>
                <h2>从一个想法，开始你的下一部短剧</h2>
                <p>一起确认风格、视频配置和语言，再逐步审阅角色、场景与分镜。</p>
            </div>
            <div className="drama-guide-composer">
                <div className="drama-guide-entry-modes" aria-label="输入内容类型">
                    {(
                        [
                            { value: "brief", label: "创作想法", icon: Sparkles },
                            { value: "source", label: "已有正文", icon: FileText },
                        ] as const
                    ).map(({ value, label, icon: Icon }) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={mode === value}
                            disabled={create.isPending}
                            onClick={() => {
                                setMode(value);
                                setFileName("");
                            }}
                        >
                            <Icon className="size-3.5" />
                            {label}
                        </button>
                    ))}
                </div>
                <Input.TextArea
                    value={text}
                    disabled={create.isPending}
                    onChange={(event) => setText(event.target.value)}
                    autoSize={{ minRows: 3, maxRows: 7 }}
                    aria-label={mode === "brief" ? "短剧创作想法" : "短剧正文"}
                    placeholder={mode === "brief" ? "想做什么故事？告诉我题材、人物或一句灵感，我们一起把它变成短剧。" : "粘贴小说、故事正文；进入后可与 Agent 一起完善配置。"}
                />
                <div className="drama-guide-composer-bottom">
                    <div className="drama-guide-entry-hint">
                        <Button type="text" size="small" icon={<Paperclip className="size-4" />} disabled={create.isPending} onClick={() => fileRef.current?.click()}>
                            导入正文
                        </Button>
                        <span>{fileName || "先做文字，参考图可按需生成"}</span>
                    </div>
                    <Button type="primary" icon={<ArrowUp className="size-4" />} loading={create.isPending} disabled={!text.trim() || !settings || problem} onClick={() => create.mutate()}>
                        开始创作
                    </Button>
                </div>
            </div>
            {showSteps ? (
                <div className="drama-drop-steps" role="list" aria-label="短剧制作流程">
                    {PIPELINE.map((step, index) => (
                        <span key={step} role="listitem">
                            <b>{index + 1}</b>
                            {step}
                        </span>
                    ))}
                </div>
            ) : null}
            {problem ? (
                <p className="drama-guide-notice" role="alert">
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
                className="hidden"
                accept=".txt,.md,.markdown"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadFile(file);
                    event.target.value = "";
                }}
            />
        </section>
    );
}
