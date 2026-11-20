import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { CheckCircle2, Download, FileText, PencilLine, Plus, Save, Upload } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { analyzeNovel, DRAMA_REFERENCE_SOURCE_CHARS, EPISODE_SOURCE_CHARS, MAX_CHAPTER_WORDS, sourceChars } from "@/lib/drama/novel-parse";
import { formatDramaSourceMarkdown } from "@/lib/drama/source-reference-markdown";
import { ApiError } from "@/services/api/request";
import {
    getDramaChapter,
    getDramaEpisode,
    getDramaSourceExport,
    listDramaChapters,
    rescriptDramaEpisode,
    saveDramaGuideSource,
    updateDramaChapter,
    updateDramaSettings,
    type DramaChapterInput,
    type DramaSourceFormat,
    type DramaSummary,
} from "@/services/api/drama";
import { updateProject } from "@/services/api/projects";
import { useUserStore } from "@/stores/use-user-store";

import { SOURCE_FORMAT_LABEL, SourceFormatPicker } from "./drama-shared";
import { dramaKeys } from "./studio/use-studio";
import { DRAMA_SOURCE_FILE_MAX_BYTES, formatDramaSourceFileSize, readDramaSourceFile } from "./drama-source-file";
import { episodeAssetsPending } from "./workflow-state";

import "./workflow-source.css";

type ChapterDraft = { id: string; title: string; text: string; baseline: string; baselineTitle: string; revision: number };
type MetadataDraft = { format: DramaSourceFormat; baseline: DramaSourceFormat; revision: number };
type Replacement = { fileName: string; chapters: DramaChapterInput[]; referenceText?: string; revision: number };
type CreationDraft = { mode: "selected" | "single"; revision: number; format: DramaSourceFormat; name: string; description: string; dramaType: "comic" | "live_action" | "narration"; aspectRatio: string };
type SourceProps = { summary: DramaSummary; step?: "source" | "review"; episodeId?: string; onChanged: () => void; onContinue?: () => void; onStoryboardStarted?: () => void; busy?: boolean; onDirtyChange?: (dirty: boolean, busy: boolean) => void };

const DRAMA_TYPES = [
    { value: "comic" as const, label: "漫剧", cover: "/short-drama-types/comic.jpg" },
    { value: "live_action" as const, label: "真人剧", cover: "/short-drama-types/live-action.jpg" },
    { value: "narration" as const, label: "解说漫", cover: "/short-drama-types/narration.jpg" },
];
const VIDEO_RATIOS = [
    { value: "16:9", width: 20, height: 11.25 },
    { value: "4:3", width: 20, height: 15 },
    { value: "1:1", width: 20, height: 20 },
    { value: "9:16", width: 11.25, height: 20 },
    { value: "3:4", width: 15, height: 20 },
];

function staleMessage(error: unknown) {
    return error instanceof ApiError && (error.reason === "conflict" || error.status === 409);
}

function isDirty(draft: ChapterDraft) {
    return draft.text !== draft.baseline || draft.title !== draft.baselineTitle;
}

function chapterIDsFromEpisode(value: string | undefined): string[] {
    try {
        const ids: unknown = JSON.parse(value || "[]");
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

export function WorkflowSourceReview(props: SourceProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <SourceReview key={`${userId}:${props.summary.project.id}:${props.episodeId || ""}`} {...props} userId={userId} />;
}

function SourceReview({ summary, step = "review", episodeId, onChanged, onContinue, onStoryboardStarted, busy = false, onDirtyChange, userId }: SourceProps & { userId: string }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const projectId = summary.project.id;
    const configuring = (summary.guide?.step || summary.production.guideStep) === "configuring";
    const revision = summary.production.revision;
    const serverFormat: DramaSourceFormat = ["novel", "script", "storyboard"].includes(summary.project.sourceType) ? (summary.project.sourceType as DramaSourceFormat) : summary.episodes[0]?.sourceFormat || "novel";
    const [selectedId, setSelectedId] = useState("");
    const [editing, setEditing] = useState(false);
    const [scopeOpen, setScopeOpen] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, ChapterDraft>>({});
    const [metadata, setMetadata] = useState<MetadataDraft | null>(null);
    const [replacement, setReplacement] = useState<Replacement | null>(null);
    const [inputMode, setInputMode] = useState<"file" | "paste">("file");
    const [pasteText, setPasteText] = useState("");
    const [reading, setReading] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [creation, setCreation] = useState<CreationDraft | null>(null);
    const [creationError, setCreationError] = useState("");
    const creationLock = useRef(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const mounted = useRef(false);
    const readGeneration = useRef(0);
    const latest = useRef({ onChanged, onDirtyChange, onContinue, onStoryboardStarted, chapterId: "" });
    const current = () => mounted.current && (useUserStore.getState().user?.id || "") === userId;

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            readGeneration.current += 1;
            latest.current.onDirtyChange?.(false, false);
        };
    }, []);

    const chapters = useQuery({
        queryKey: [...dramaKeys.chapters(projectId), userId],
        queryFn: ({ signal }) => listDramaChapters(projectId, signal),
    });
    const episode = useQuery({ queryKey: [...dramaKeys.episode(projectId, episodeId || ""), userId], queryFn: ({ signal }) => getDramaEpisode(projectId, episodeId!, signal), enabled: Boolean(episodeId) });
    const episodeChapterIDs = chapterIDsFromEpisode(episode.data?.episode.chapterIdsJson);
    const visibleChapters = episodeId ? chapters.data?.chapters.filter((chapter) => episodeChapterIDs.includes(chapter.id)) : chapters.data?.chapters;
    const chapterId = visibleChapters?.some((chapter) => chapter.id === selectedId) ? selectedId : visibleChapters?.[0]?.id || "";
    latest.current = { onChanged, onDirtyChange, onContinue, onStoryboardStarted, chapterId };
    const source = useQuery({
        queryKey: ["drama", projectId, "chapter", chapterId, userId, revision],
        queryFn: ({ signal }) => getDramaChapter(projectId, chapterId, signal),
        enabled: Boolean(chapterId),
    });

    useEffect(() => {
        const chapter = source.data?.chapter;
        if (!chapter || chapter.id !== chapterId) return;
        setDrafts((previous) => {
            const old = previous[chapter.id];
            if (old && (isDirty(old) || old.revision === revision)) return previous;
            return { ...previous, [chapter.id]: { id: chapter.id, title: chapter.title, text: chapter.sourceText, baseline: chapter.sourceText, baselineTitle: chapter.title, revision } };
        });
    }, [source.data, chapterId, revision, Boolean(drafts[chapterId])]);

    useEffect(() => {
        if (!chapters.data) return;
        const baseline = serverFormat;
        setMetadata((old) => {
            if (old && old.format !== old.baseline) return old;
            if (old?.baseline === baseline && old.revision === revision) return old;
            return { format: serverFormat, baseline, revision };
        });
    }, [chapters.data, serverFormat, revision, metadata === null]);

    const draft = drafts[chapterId];
    const chapterDirty = Boolean(draft && isDirty(draft));
    const metadataDirty = Boolean(metadata && metadata.format !== metadata.baseline);
    const chapterDraftDirty = Object.values(drafts).some(isDirty);
    const dirty = chapterDraftDirty || metadataDirty || Boolean(replacement) || Boolean(pasteText.trim()) || Boolean(creation);
    const stale = Boolean(draft && draft.revision !== revision);
    const tooLong = Boolean(draft && sourceChars(draft.text) > Math.max(EPISODE_SOURCE_CHARS, sourceChars(draft.baseline)));

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: dramaKeys.chapters(projectId) });
        latest.current.onChanged();
    };
    const save = useMutation({
        mutationFn: async (input: ChapterDraft) => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            if (input.revision !== revision) throw new Error("正文已有更新，请重新载入后再保存");
            if (sourceChars(input.text) > Math.max(EPISODE_SOURCE_CHARS, sourceChars(input.baseline))) throw new Error("本章正文过长，请拆分或缩短后再保存");
            const result = await updateDramaChapter(projectId, input.id, { title: input.title, text: input.text, expectedRevision: input.revision });
            return { input, chapter: result.chapter };
        },
        onSuccess: ({ input, chapter }) => {
            if (!current()) return;
            setDrafts((previous) => {
                const next = Object.fromEntries(Object.entries(previous).map(([id, item]) => [id, item.revision === input.revision ? { ...item, revision: input.revision + 1 } : item]));
                const saved = next[input.id];
                if (saved && saved.title === input.title && saved.text === input.text) next[input.id] = { ...saved, title: chapter.title, text: chapter.sourceText, baseline: chapter.sourceText, baselineTitle: chapter.title };
                return next;
            });
            setMetadata((old) => (old?.revision === input.revision ? { ...old, revision: input.revision + 1 } : old));
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter", chapter.id] });
            refresh();
            if (latest.current.chapterId === input.id) {
                setEditing(false);
                message.success("已保存本章");
            }
        },
        onError: (error) => {
            if (!current()) return;
            message.error(staleMessage(error) ? "正文已被其他操作更新，未覆盖。请重新载入后再改。" : error instanceof Error ? error.message : "保存失败");
            latest.current.onChanged();
        },
    });

    const saveMetadata = useMutation({
        mutationFn: async (input: MetadataDraft) => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            if (input.revision !== revision) throw new Error("正文已有更新，请重新载入素材类型后再保存");
            if (chapters.data?.chapters.some((chapter) => chapter.wordCount > EPISODE_SOURCE_CHARS)) throw new Error("单章不能超过 1.2 万字，请先拆分或缩短正文");
            return saveDramaGuideSource(projectId, { expectedRevision: input.revision, sourceFormat: input.format });
        },
        onSuccess: () => {
            if (!current()) return;
            setMetadata(null);
            setDrafts({});
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter"] });
            refresh();
            message.success("已保存素材类型");
        },
        onError: (error) => {
            if (current()) message.error(staleMessage(error) ? "正文已被更新，未保存素材类型，请重新载入。" : error instanceof Error ? error.message : "保存失败");
        },
    });

    const replace = useMutation({
        mutationFn: async (input: Replacement) => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            if (input.revision !== revision) throw new Error("正文已有更新，请重新上传后再替换");
            if (input.chapters.some((chapter) => sourceChars(chapter.text) > EPISODE_SOURCE_CHARS)) throw new Error("单章不能超过 1.2 万字，请拆分正文后再导入");
            if (input.referenceText && sourceChars(input.referenceText) > DRAMA_REFERENCE_SOURCE_CHARS) throw new Error("请将作品参考资料缩短到 1.2 万字以内");
            return saveDramaGuideSource(projectId, { expectedRevision: input.revision, chapters: input.chapters, referenceText: input.referenceText, sourceFormat: metadata?.format || serverFormat });
        },
        onSuccess: () => {
            if (!current()) return;
            setDrafts({});
            setMetadata(null);
            setSelectedId("");
            setReplacement(null);
            setPasteText("");
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter"] });
            refresh();
            message.success("已更新来源正文");
        },
        onError: (error) => {
            if (current()) message.error(staleMessage(error) ? "正文已被更新，未替换。请重新上传后再试。" : error instanceof Error ? error.message : "替换失败");
        },
    });

    const createEpisodes = useMutation({
        mutationFn: async (input: CreationDraft) => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            const cached = queryClient.getQueryData<DramaSummary>(dramaKeys.summary(projectId));
            if (input.revision !== Math.max(revision, cached?.production.revision || 0)) throw new Error("正文或设置已有更新，请取消后重新打开创建窗口");
            if (!configuring || chapterDraftDirty || replacement || pasteText.trim()) throw new Error("请先保存或放弃未完成的正文修改");
            if (!input.name.trim()) throw new Error("请填写剧集名称");
            if (!chapters.data?.chapters.length) throw new Error("没有可制作的正文");
            if (chapters.data.chapters.some((chapter) => chapter.wordCount > EPISODE_SOURCE_CHARS)) throw new Error("单章不能超过 1.2 万字，请先拆分或缩短正文");
            const checkpoint = (next: DramaSummary) => {
                if (!current()) throw new Error("登录状态已变更，请重新操作");
                queryClient.setQueryData<DramaSummary>(dramaKeys.summary(projectId), (old) => (old && old.production.revision > next.production.revision ? old : next));
                setMetadata({ format: input.format, baseline: input.format, revision: next.production.revision });
                setDrafts({});
                setCreation((old) => (old ? { ...old, revision: next.production.revision } : old));
                return next;
            };
            let next = checkpoint(await saveDramaGuideSource(projectId, { expectedRevision: input.revision, sourceFormat: input.format }));
            if (next.production.settings.aspectRatio !== input.aspectRatio || next.production.settings.dramaType !== input.dramaType) {
                next = checkpoint(await updateDramaSettings(projectId, { expectedRevision: next.production.revision, settings: { ...next.production.settings, aspectRatio: input.aspectRatio, dramaType: input.dramaType } }));
            }
            if (next.project.name !== input.name.trim() || next.project.description !== input.description || next.project.aspectRatio !== input.aspectRatio) {
                const result = await updateProject(projectId, { name: input.name.trim(), description: input.description, aspectRatio: input.aspectRatio });
                next = checkpoint({ ...next, project: result.project });
            }
            return next;
        },
        onSuccess: () => {
            if (!current()) return;
            setCreation(null);
            setCreationError("");
            setMetadata(null);
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter"] });
            refresh();
            latest.current.onDirtyChange?.(false, false);
            message.success("已保存剧集信息，继续选择风格");
            latest.current.onContinue?.();
        },
        onError: (error) => {
            if (!current()) return;
            setCreationError(staleMessage(error) ? "正文或设置已被更新。已保存的更改会保留，请取消后重新打开创建窗口。" : error instanceof Error ? error.message : "创建设置未完成，请重试");
            latest.current.onChanged();
        },
        onSettled: () => {
            creationLock.current = false;
        },
    });

    const storyboard = useMutation({
        mutationFn: async () => {
            if (!current() || !episodeId || episode.data?.episode.stage !== "draft") throw new Error("本集状态已更新，请刷新后再操作");
            if (!canStartStoryboard || chapterDraftDirty || dirty || busy) throw new Error("请先完成当前操作再生成分镜");
            return rescriptDramaEpisode(projectId, episodeId);
        },
        onSuccess: (detail) => {
            if (!current()) return;
            queryClient.setQueryData([...dramaKeys.episode(projectId, episodeId!), userId], detail);
            void queryClient.invalidateQueries({ queryKey: dramaKeys.episode(projectId, episodeId!) });
            refresh();
            message.success("已开始生成本集分镜");
            latest.current.onDirtyChange?.(false, false);
            latest.current.onStoryboardStarted?.();
        },
        onError: (error) => {
            if (current()) message.error(error instanceof Error ? error.message : "分镜生成未能提交");
        },
    });
    const guideStep = summary.guide?.step || summary.production.guideStep;
    const assetsPending = episodeAssetsPending(summary, episodeId);
    const canStartStoryboard = (!guideStep || guideStep === "story" || guideStep === "completed") && !assetsPending;
    const working = busy || reading || reloading || downloading || save.isPending || replace.isPending || saveMetadata.isPending || createEpisodes.isPending || storyboard.isPending;
    const totalChapters = chapters.data?.chapters.length || 0;
    const chapterScopeSummary = `原文共 ${totalChapters} 章 · 共 ${summary.episodes.length} 集`;
    const replacementReferenceTooLong = Boolean(replacement?.referenceText && sourceChars(replacement.referenceText) > DRAMA_REFERENCE_SOURCE_CHARS);
    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, working);
    }, [dirty, working]);

    const openCreation = (mode: CreationDraft["mode"]) => {
        if (working || chapterDraftDirty || replacement || pasteText.trim() || !configuring || !metadata) return;
        setCreationError("");
        setCreation({
            mode,
            revision,
            format: metadata.format,
            name: summary.project.name,
            description: summary.project.description || "",
            dramaType: summary.production.settings.dramaType || "comic",
            aspectRatio: summary.production.settings.aspectRatio,
        });
    };

    const previewReplacement = (content: string, fileName: string) => {
        const format = metadata?.format || serverFormat;
        const parsed = analyzeNovel(content, { perEpisode: true, script: format === "script", novelReference: format !== "script" });
        if (!parsed.chapters.length) throw new Error(parsed.issues.find(({ kind }) => kind === "invalid_export" || kind === "reference_only")?.message || "没有可导入的正文");
        if (parsed.chapters.some((chapter) => sourceChars(chapter.text) > MAX_CHAPTER_WORDS)) throw new Error("新正文单章超过 6 万字，请拆分后再导入");
        const chapters = parsed.chapters.map(({ title, text }) => ({ title, text }));
        setReplacement({ fileName, chapters, referenceText: parsed.referenceText, revision });
    };
    const loadReplacement = async (file: File) => {
        if (working || chapterDraftDirty || replacement || pasteText.trim() || !configuring || episodeId) return;
        const generation = ++readGeneration.current;
        setReading(true);
        try {
            const content = await readDramaSourceFile(file);
            if (!current() || generation !== readGeneration.current) return;
            previewReplacement(content, file.name);
        } catch (error) {
            if (current() && generation === readGeneration.current) message.error(error instanceof Error ? error.message : "文件读取失败");
        } finally {
            if (current() && generation === readGeneration.current) setReading(false);
        }
    };
    const reloadChapter = async () => {
        const target = chapterId;
        setReloading(true);
        try {
            const result = await source.refetch();
            if (!current()) return;
            if (result.error) throw result.error;
            const chapter = result.data?.chapter;
            if (chapter?.id === target) setDrafts((previous) => ({ ...previous, [target]: { id: target, title: chapter.title, text: chapter.sourceText, baseline: chapter.sourceText, baselineTitle: chapter.title, revision } }));
        } catch (error) {
            if (current()) message.error(error instanceof Error ? error.message : "重新载入失败");
        } finally {
            if (current()) setReloading(false);
        }
    };
    const download = async () => {
        if (working || !visibleChapters?.length) return;
        setDownloading(true);
        try {
            let exportChapters: DramaChapterInput[];
            let sourceFormat: DramaSourceFormat;
            let referenceText: string | undefined;
            if (episodeId) {
                exportChapters = await Promise.all(
                    visibleChapters.map(async (chapter) => {
                        const local = drafts[chapter.id];
                        if (local) return { title: local.title, text: local.text };
                        const result = await queryClient.fetchQuery({ queryKey: ["drama", projectId, "chapter", chapter.id, userId, revision], queryFn: ({ signal }) => getDramaChapter(projectId, chapter.id, signal) });
                        return { title: result.chapter.title, text: result.chapter.sourceText };
                    }),
                );
                sourceFormat = episode.data?.episode.sourceFormat || serverFormat;
            } else {
                const snapshot = await getDramaSourceExport(projectId);
                const stored = new Map(snapshot.chapters.map((chapter) => [chapter.id, chapter]));
                const edits = Object.values(drafts).filter(isDirty);
                const staleEdit = edits.some((edit) => {
                    const original = stored.get(edit.id);
                    return edit.revision !== snapshot.revision || original?.title !== edit.baselineTitle || original?.text !== edit.baseline;
                });
                const formatEdit = metadataDirty ? metadata : null;
                if (staleEdit || (formatEdit && (formatEdit.revision !== snapshot.revision || formatEdit.baseline !== snapshot.sourceFormat))) {
                    throw new Error("作品已被更新。请核对未保存的修改后再下载。");
                }
                exportChapters = snapshot.chapters.map((chapter) => {
                    const local = drafts[chapter.id];
                    return local && isDirty(local) ? { title: local.title, text: local.text } : chapter;
                });
                sourceFormat = formatEdit?.format ?? snapshot.sourceFormat;
                referenceText = snapshot.referenceText;
            }
            if (!current()) return;
            if (!exportChapters.length) throw new Error("作品当前没有可下载的正文");
            const text = formatDramaSourceMarkdown({ sourceFormat, referenceText, chapters: exportChapters });
            const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
            try {
                const link = document.createElement("a");
                link.href = url;
                link.download = `${episodeId ? episode.data?.episode.title || "本集剧本" : summary.project.name || "分集剧本"}.md`;
                link.click();
            } finally {
                URL.revokeObjectURL(url);
            }
        } catch (error) {
            if (current()) message.error(error instanceof Error ? error.message : "下载剧本失败，请重试");
        } finally {
            if (current()) setDownloading(false);
        }
    };

    const metadataActions =
        configuring && !episodeId && metadata && (scopeOpen || metadataDirty) ? (
            <div className="drama-source-bar drama-source-scope">
                <span>{metadataDirty ? "素材类型有未保存的修改。" : `全部 ${totalChapters} 章已加入分集列表。`}</span>
                {metadata.revision !== revision && metadataDirty ? (
                    <Button
                        disabled={working}
                        onClick={() => {
                            setMetadata(null);
                            void chapters.refetch();
                        }}
                    >
                        重新载入素材类型
                    </Button>
                ) : (
                    <div className="drama-source-actions">
                        {metadataDirty ? (
                            <Button disabled={working} onClick={() => setMetadata(null)}>
                                还原素材类型
                            </Button>
                        ) : null}
                        <Button disabled={working || !metadataDirty || chapterDraftDirty || Boolean(replacement) || Boolean(pasteText.trim())} loading={saveMetadata.isPending} onClick={() => saveMetadata.mutate(metadata)}>
                            保存素材类型
                        </Button>
                    </div>
                )}
            </div>
        ) : null;

    return (
        <section className={`drama-source-page ${step === "source" ? "is-source" : "is-review"} ${scopeOpen || metadataDirty ? "is-scope-adjustment" : ""}`} aria-label={step === "source" ? "上传剧本" : "剧本格式"}>
            <header className={`drama-source-heading ${step === "source" ? "is-upload" : ""}`}>
                <div>
                    <h2>{step === "source" ? (serverFormat === "novel" ? "从小说开始" : serverFormat === "storyboard" ? "从分镜开始" : "从剧本开始") : "分集剧本"}</h2>
                    <p>{step === "source" ? "上传符合格式的正文，确认文件后继续核对剧本。" : episodeId ? "确认本集关联的剧本，保存仅修改当前章节。" : "确认您的剧本，并选择单集剧本进行视频创作。"}</p>
                    {chapters.data ? <p className="drama-source-chapter-summary">{chapterScopeSummary}</p> : null}
                    {configuring && !episodeId ? <p className="drama-source-note">全部章节已加入分集列表，可逐集开始制作。</p> : null}
                </div>
                {step === "review" ? (
                    <div className="drama-source-actions">
                        {episode.data?.episode.stage === "draft" ? (
                            <Button
                                type="primary"
                                loading={storyboard.isPending}
                                disabled={working || dirty || !canStartStoryboard}
                                title={assetsPending ? "本集主体提取尚未完成" : !canStartStoryboard ? "请先完成首次配置并确认主体资产" : undefined}
                                onClick={() => storyboard.mutate()}
                            >
                                {storyboard.isPending ? "正在生成分镜…" : "生成分镜"}
                            </Button>
                        ) : null}
                        {step === "review" && !editing ? (
                            <Button type="text" icon={<PencilLine className="size-3.5" aria-hidden />} disabled={working || !draft || Boolean(replacement)} onClick={() => setEditing(true)} data-source-edit>
                                手动编辑
                            </Button>
                        ) : null}
                        {step === "review" ? (
                            <Button icon={<Download className="size-3.5" aria-hidden />} disabled={working || !visibleChapters?.length} loading={downloading} onClick={() => void download()}>
                                {episodeId ? "下载本集剧本" : "下载剧本"}
                            </Button>
                        ) : null}
                        {step === "review" && configuring && !episodeId ? (
                            <>
                                <Button icon={<Plus className="size-3.5" aria-hidden />} disabled={working || chapterDraftDirty || Boolean(replacement) || Boolean(pasteText.trim()) || !chapterId} onClick={() => openCreation("single")}>
                                    创建单集
                                </Button>
                                <Button
                                    type="primary"
                                    icon={<Plus className="size-3.5" aria-hidden />}
                                    disabled={working || chapterDraftDirty || Boolean(replacement) || Boolean(pasteText.trim()) || !metadata || !totalChapters}
                                    onClick={() => openCreation("selected")}
                                >
                                    创建剧集
                                </Button>
                            </>
                        ) : null}
                    </div>
                ) : null}
            </header>
            {step === "source" ? (
                <div className="drama-source-import-layout">
                    <div className="drama-source-import-panel">
                        <div className="drama-source-input-modes" role="group" aria-label="导入方式">
                            <Button icon={<Upload className="size-3.5" aria-hidden />} aria-pressed={inputMode === "file"} disabled={working || Boolean(replacement)} onClick={() => setInputMode("file")}>
                                上传文件
                            </Button>
                            <Button icon={<PencilLine className="size-3.5" aria-hidden />} aria-pressed={inputMode === "paste"} disabled={working || Boolean(replacement)} onClick={() => setInputMode("paste")}>
                                手动输入 / 粘贴
                            </Button>
                        </div>
                        {inputMode === "file" ? (
                            <button
                                type="button"
                                className="drama-source-upload-zone"
                                disabled={working || chapterDraftDirty || Boolean(replacement) || Boolean(pasteText.trim()) || !configuring}
                                onClick={() => fileRef.current?.click()}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    const file = event.dataTransfer.files[0];
                                    if (file) void loadReplacement(file);
                                }}
                            >
                                <span className="drama-source-file-icon">
                                    <FileText aria-hidden />
                                    {summary.production.chapterCount > 0 ? <CheckCircle2 className="drama-source-ready-badge" aria-hidden /> : null}
                                </span>
                                <strong>{reading ? "正在读取文件…" : summary.production.chapterCount > 0 ? "文件已就绪" : "点击或拖拽正文至此开始上传"}</strong>
                                {summary.production.chapterCount > 0 ? (
                                    <span className="drama-source-file-name">
                                        <FileText className="size-4" aria-hidden />
                                        {summary.project.name} · {chapters.data?.chapters.length ?? summary.production.chapterCount} 章
                                    </span>
                                ) : null}
                                <span className="drama-source-upload-hint">{configuring ? "点击或拖拽可重新上传，确认前保留原正文" : "可在剧本格式页查看和编辑正文"}</span>
                                <small>支持 TXT、MD、Markdown、DOCX，不超过 {formatDramaSourceFileSize(DRAMA_SOURCE_FILE_MAX_BYTES)}</small>
                            </button>
                        ) : (
                            <div className="drama-source-paste-panel">
                                <label htmlFor={`drama-source-paste-${projectId}`}>粘贴新的来源正文</label>
                                <Input.TextArea
                                    id={`drama-source-paste-${projectId}`}
                                    aria-label="粘贴新的来源正文"
                                    value={pasteText}
                                    placeholder={SOURCE_FORMAT_LABEL[metadata?.format || serverFormat].placeholder}
                                    disabled={working || chapterDraftDirty || Boolean(replacement) || !configuring}
                                    onChange={(event) => setPasteText(event.target.value)}
                                />
                                <div className="drama-source-bar">
                                    <span>{sourceChars(pasteText).toLocaleString()} 字</span>
                                    <div className="drama-source-actions">
                                        <Button disabled={working || !pasteText || Boolean(replacement)} onClick={() => setPasteText("")}>
                                            清空输入
                                        </Button>
                                        <Button
                                            type="primary"
                                            disabled={working || !pasteText.trim() || chapterDraftDirty || Boolean(replacement) || !configuring}
                                            onClick={() => {
                                                try {
                                                    previewReplacement(pasteText, "手动输入的正文");
                                                } catch (error) {
                                                    message.error(error instanceof Error ? error.message : "正文解析失败");
                                                }
                                            }}
                                        >
                                            解析正文
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {chapterDraftDirty ? (
                            <p role="alert" className="drama-source-note">
                                剧本格式页还有未保存的章节修改，请先保存或放弃修改，再更换来源正文。
                            </p>
                        ) : null}
                        {pasteText.trim() && inputMode === "file" ? <p className="drama-source-note">还有未解析的粘贴正文。请先切回手动输入并解析，或清空后上传文件。</p> : null}
                        {configuring ? (
                            <details className="drama-source-format-options">
                                <summary>素材类型：{SOURCE_FORMAT_LABEL[metadata?.format || serverFormat].title}</summary>
                                <SourceFormatPicker value={metadata?.format || serverFormat} disabled={!metadata || working || Boolean(replacement)} row onChange={(format) => setMetadata((old) => (old ? { ...old, format } : old))} />
                            </details>
                        ) : null}
                    </div>
                    <aside className="drama-source-format-help" aria-label="剧本格式说明">
                        <h3>剧本格式说明</h3>
                        <p>若上传正文的格式与规定格式不符，可能影响剧本解析结果。</p>
                        <h4>拆分单集格式示意</h4>
                        <ol>
                            <li>将“第1集”或“第一集”独立成行。</li>
                            <li>小说可使用“第一章”等章节标题。</li>
                            <li>数字可使用阿拉伯数字或汉字。</li>
                        </ol>
                        <div className="drama-source-format-example">
                            <strong>第1集</strong>
                            <p>1-1场 客厅 日 内</p>
                            <p>出场角色：林晚、许舟</p>
                            <p>
                                △林晚推门而入。
                                <br />
                                林晚：你怎么还在这里？
                            </p>
                        </div>
                        <h4>拆分场次格式示意</h4>
                        <ol>
                            <li>使用“1-1场”等场次编号。</li>
                            <li>编号位于该行文字开头。</li>
                            <li>同一行补充地点、日夜和内外景。</li>
                        </ol>
                        <div className="drama-source-format-example">
                            <strong>1-2场 庭院 夜 外</strong>
                            <p>出场角色：林晚</p>
                            <p>△夜雨落下，林晚停在门前。</p>
                        </div>
                        <details className="drama-source-format-options">
                            <summary>更多导入说明</summary>
                            <ul>
                                {(SOURCE_FORMAT_LABEL[metadata?.format || serverFormat].guide || [SOURCE_FORMAT_LABEL[metadata?.format || serverFormat].detail]).map((tip) => (
                                    <li key={tip}>{tip}</li>
                                ))}
                            </ul>
                            <p className="drama-source-note">旧版 Word（.doc）请先另存为 DOCX，单章不超过 1.2 万字，全部章节会加入分集列表。</p>
                        </details>
                    </aside>
                </div>
            ) : configuring && !episodeId ? (
                <div className="drama-source-review-settings thin-scrollbar" role="region" aria-label="素材类型设置" tabIndex={0}>
                    <details className="drama-source-format-options drama-source-review-options" open={scopeOpen || metadataDirty} onToggle={(event) => setScopeOpen(event.currentTarget.open)}>
                        <summary>
                            素材类型<span>{metadataDirty ? "有未保存修改" : SOURCE_FORMAT_LABEL[metadata?.format || serverFormat].title}</span>
                        </summary>
                        <SourceFormatPicker value={metadata?.format || serverFormat} disabled={!metadata || working || Boolean(replacement)} row onChange={(format) => setMetadata((old) => (old ? { ...old, format } : old))} />
                    </details>
                    {metadataActions}
                </div>
            ) : (
                <p className="drama-source-note">{episodeId ? "保存只写入当前章节；已生成的剧本与镜头需单独重新生成。" : "配置已确认。保存单章正文不会自动重新改编已有剧本。"}</p>
            )}
            {step === "source" ? metadataActions : null}
            {replacement ? (
                <div className="drama-source-replacement" aria-label="替换正文预览">
                    <h3>替换预览：{replacement.fileName}</h3>
                    <p>解析出 {replacement.chapters.length} 章，全部加入分集列表。确认后会替换原正文与待制作分集。</p>
                    {replacementReferenceTooLong ? (
                        <p role="alert">请将作品参考资料缩短到 1.2 万字以内</p>
                    ) : replacement.referenceText ? (
                        <p>已识别作品参考资料，供角色、场景和道具提取。</p>
                    ) : replacement.referenceText === "" ? (
                        <p>导出文件的参考资料为空，确认后会清除作品原有的参考资料。</p>
                    ) : null}
                    {replacement.chapters.map((chapter, index) => (
                        <div key={index} className="drama-source-replacement-item">
                            {chapter.title} · {sourceChars(chapter.text).toLocaleString()} 字{sourceChars(chapter.text) > EPISODE_SOURCE_CHARS ? "（请先拆分正文）" : ""}
                        </div>
                    ))}
                    <div className="drama-source-actions">
                        <Button disabled={working} onClick={() => setReplacement(null)}>
                            取消替换
                        </Button>
                        <Button
                            type="primary"
                            disabled={working || replacementReferenceTooLong || replacement.chapters.some((chapter) => sourceChars(chapter.text) > EPISODE_SOURCE_CHARS)}
                            loading={replace.isPending}
                            onClick={() => replace.mutate(replacement)}
                        >
                            确认替换正文
                        </Button>
                    </div>
                </div>
            ) : null}
            {step === "review" ? (
                <div className="drama-source-review-layout">
                    <div className="drama-source-chapter-list thin-scrollbar" role="listbox" aria-label="章节列表">
                        <p>{episodeId && episode.isPending ? "正在读取本集章节" : visibleChapters ? (episodeId ? `本集关联 ${visibleChapters.length} 章` : chapterScopeSummary) : "正在读取章节"}</p>
                        {visibleChapters?.map((chapter) => (
                            <div key={chapter.id} className={`drama-source-chapter-item ${chapter.id === chapterId ? "is-selected" : ""}`}>
                                <button type="button" role="option" aria-selected={chapter.id === chapterId} onClick={() => setSelectedId(chapter.id)}>
                                    <strong>
                                        {drafts[chapter.id]?.title || chapter.title || "未命名章节"}
                                        {drafts[chapter.id] && isDirty(drafts[chapter.id]) ? " · 未保存" : ""}
                                    </strong>
                                    <span>
                                        {chapter.wordCount.toLocaleString()} 字 · {chapter.episodeNumber ? `第 ${chapter.episodeNumber} 集` : "已加入分集列表"}
                                    </span>
                                </button>
                            </div>
                        ))}
                        {chapters.isError ? (
                            <p role="alert">
                                章节列表读取失败。
                                <Button size="small" type="link" onClick={() => void chapters.refetch()}>
                                    重试
                                </Button>
                            </p>
                        ) : null}
                        {episodeId && episode.isError ? (
                            <p role="alert">
                                本集章节读取失败。
                                <Button size="small" type="link" onClick={() => void episode.refetch()}>
                                    重试
                                </Button>
                            </p>
                        ) : null}
                    </div>
                    <div className="drama-source-editor">
                        {source.isError && !draft ? (
                            <p role="alert">
                                本章正文读取失败。
                                <Button size="small" type="link" onClick={() => void source.refetch()}>
                                    重试
                                </Button>
                            </p>
                        ) : draft ? (
                            <>
                                {!editing ? (
                                    <article className="drama-source-reading" aria-label="章节预览">
                                        <h3>{draft.title}</h3>
                                        <div key={chapterId} className="drama-source-reading-content thin-scrollbar" role="region" aria-label="章节正文预览" tabIndex={0}>
                                            {draft.text}
                                        </div>
                                        {chapterDirty ? <p className="drama-source-note">本章有未保存修改，点击手动编辑继续。</p> : null}
                                        {stale ? (
                                            <p className="drama-source-note" role="alert">
                                                正文已有更新，请进入手动编辑后重新载入。
                                            </p>
                                        ) : null}
                                    </article>
                                ) : null}
                                <div className="drama-source-edit-fields" hidden={!editing}>
                                    <div className="drama-source-editor-heading">
                                        <label htmlFor={`drama-source-title-${projectId}`}>章节标题</label>
                                        <span>{sourceChars(draft.text).toLocaleString()} 字</span>
                                    </div>
                                    <Input
                                        id={`drama-source-title-${projectId}`}
                                        aria-label="章节标题"
                                        value={draft.title}
                                        disabled={working || Boolean(replacement)}
                                        onChange={(event) => setDrafts({ ...drafts, [chapterId]: { ...draft, title: event.target.value } })}
                                    />
                                    <label className="drama-source-body-label" htmlFor={`drama-source-body-${projectId}`}>
                                        章节正文
                                    </label>
                                    <Input.TextArea
                                        id={`drama-source-body-${projectId}`}
                                        aria-label="章节正文"
                                        value={draft.text}
                                        disabled={working || Boolean(replacement)}
                                        onChange={(event) => setDrafts({ ...drafts, [chapterId]: { ...draft, text: event.target.value } })}
                                    />
                                    <div className="drama-source-bar drama-source-editor-footer">
                                        {stale ? (
                                            <span role="alert">正文已有更新，重新载入将放弃本章未保存的修改。</span>
                                        ) : tooLong ? (
                                            <span role="alert">本章正文过长，请拆分或缩短后再保存。</span>
                                        ) : chapterDirty ? (
                                            <span>本章有未保存的修改，其它章节草稿会保留。</span>
                                        ) : (
                                            <span>保存只写入当前章节。</span>
                                        )}
                                        {stale ? (
                                            <Button disabled={working} onClick={() => void reloadChapter()}>
                                                重新载入
                                            </Button>
                                        ) : (
                                            <div className="drama-source-actions">
                                                {chapterDirty ? (
                                                    <Button
                                                        disabled={working || Boolean(replacement)}
                                                        onClick={() => {
                                                            setDrafts({ ...drafts, [chapterId]: { ...draft, text: draft.baseline, title: draft.baselineTitle } });
                                                            setEditing(false);
                                                        }}
                                                    >
                                                        放弃本章修改
                                                    </Button>
                                                ) : (
                                                    <Button disabled={working} onClick={() => setEditing(false)}>
                                                        取消编辑
                                                    </Button>
                                                )}
                                                <Button type="primary" icon={<Save className="size-3.5" aria-hidden />} disabled={working || !chapterDirty || tooLong || Boolean(replacement)} loading={save.isPending} onClick={() => save.mutate(draft)}>
                                                    保存本章
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <p role="status">{chapterId ? "正在读取正文…" : episodeId && episode.isPending ? "正在读取本集关联的章节…" : episodeId ? "本集尚无可编辑的原文章节" : "还没有可确认的章节"}</p>
                        )}
                    </div>
                </div>
            ) : null}
            <input
                ref={fileRef}
                type="file"
                className="drama-workflow-file-input"
                accept=".txt,.md,.markdown,.docx,text/plain,text/markdown"
                aria-label="替换正文文件"
                disabled={working || chapterDraftDirty || Boolean(replacement) || Boolean(pasteText.trim()) || !configuring || Boolean(episodeId)}
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadReplacement(file);
                    event.target.value = "";
                }}
            />
            <AppModal
                open={Boolean(creation)}
                title={creation?.mode === "single" ? "新建单集" : "新建剧集"}
                onCancel={() => {
                    setCreation(null);
                    setCreationError("");
                }}
                footer={null}
                centered
                width={620}
                rootClassName="drama-root"
                closable={!createEpisodes.isPending}
                maskClosable={!createEpisodes.isPending}
                keyboard={!createEpisodes.isPending}
                aria-label="创建剧集设置"
            >
                {creation ? (
                    <form
                        className="drama-source-create-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (creationLock.current) return;
                            creationLock.current = true;
                            setCreationError("");
                            createEpisodes.mutate(creation);
                        }}
                    >
                        <div className="drama-source-form-field">
                            <label htmlFor={`drama-create-name-${projectId}`}>
                                <span className="drama-source-required">*</span>剧集名称
                            </label>
                            <Input
                                id={`drama-create-name-${projectId}`}
                                aria-label="剧集名称"
                                value={creation.name}
                                maxLength={120}
                                required
                                disabled={createEpisodes.isPending}
                                onChange={(event) => setCreation({ ...creation, name: event.target.value })}
                            />
                        </div>
                        <fieldset className="drama-source-type-field" disabled={createEpisodes.isPending}>
                            <legend>
                                <span className="drama-source-required">*</span>剧集类型
                            </legend>
                            <p className="drama-source-type-help">确认制作方案后不可修改剧集类型。</p>
                            <div className="drama-source-type-cards">
                                {DRAMA_TYPES.map(({ value, label, cover }) => (
                                    <label key={value} className={`drama-source-type-card ${creation.dramaType === value ? "is-selected" : ""}`}>
                                        <input type="radio" name={`drama-type-${projectId}`} value={value} checked={creation.dramaType === value} onChange={() => setCreation({ ...creation, dramaType: value })} />
                                        <span className="drama-source-type-art">
                                            <img src={cover} alt="" />
                                        </span>
                                        <strong>{label}</strong>
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <div className="drama-source-form-field">
                            <label>导入现有剧本项目</label>
                            <div className="drama-source-origin">
                                <FileText className="size-4" aria-hidden />
                                <span>{summary.project.name}</span>
                                <strong>{totalChapters} 章</strong>
                            </div>
                            <p>全部章节已加入分集列表，集数沿用当前拆集设置，可逐集制作。</p>
                        </div>
                        <fieldset className="drama-source-ratio-field" disabled={createEpisodes.isPending}>
                            <legend>
                                <span className="drama-source-required">*</span>视频比例
                            </legend>
                            <div className="drama-source-ratio-options">
                                {VIDEO_RATIOS.map(({ value: ratio, width, height }) => (
                                    <label key={ratio} className={`drama-source-ratio-option ${creation.aspectRatio === ratio ? "is-selected" : ""}`}>
                                        <input type="radio" name={`drama-ratio-${projectId}`} value={ratio} checked={creation.aspectRatio === ratio} onChange={() => setCreation({ ...creation, aspectRatio: ratio })} />
                                        <svg className="drama-source-ratio-preview" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                            <rect x={(24 - width) / 2} y={(24 - height) / 2} width={width} height={height} rx={1} fill="none" stroke="currentColor" strokeWidth={1.5} />
                                        </svg>
                                        <span>{ratio}</span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <div className="drama-source-form-field">
                            <label htmlFor={`drama-create-description-${projectId}`}>备注</label>
                            <Input.TextArea
                                id={`drama-create-description-${projectId}`}
                                aria-label="剧集备注"
                                value={creation.description}
                                rows={3}
                                maxLength={2000}
                                disabled={createEpisodes.isPending}
                                onChange={(event) => setCreation({ ...creation, description: event.target.value })}
                            />
                        </div>
                        {creationError ? (
                            <p className="drama-source-create-error" role="alert">
                                {creationError}
                            </p>
                        ) : null}
                        <div className="drama-source-actions drama-source-create-footer">
                            <Button
                                disabled={createEpisodes.isPending}
                                onClick={() => {
                                    setCreation(null);
                                    setCreationError("");
                                }}
                            >
                                取消
                            </Button>
                            <Button type="primary" htmlType="submit" disabled={createEpisodes.isPending || !creation.name.trim()} loading={createEpisodes.isPending}>
                                新建
                            </Button>
                        </div>
                    </form>
                ) : null}
            </AppModal>
        </section>
    );
}
