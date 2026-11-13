import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { Download, Replace, Save } from "lucide-react";

import { analyzeNovel, EPISODE_SOURCE_CHARS, MAX_CHAPTER_WORDS, sourceChars } from "@/lib/drama/novel-parse";
import { ApiError } from "@/services/api/request";
import { getDramaChapter, listDramaChapters, saveDramaGuideSource, updateDramaChapter, type DramaChapterInput, type DramaSourceFormat, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { SourceFormatPicker } from "./drama-shared";
import { dramaKeys } from "./studio/use-studio";
import { readDramaSourceFile } from "./drama-source-file";

type ChapterDraft = { id: string; title: string; text: string; baseline: string; baselineTitle: string; revision: number };
type MetadataDraft = { format: DramaSourceFormat; selected: string[]; baseline: string; revision: number };
type Replacement = { fileName: string; chapters: DramaChapterInput[]; selected: number[]; revision: number };
type SourceProps = { summary: DramaSummary; onChanged: () => void; busy?: boolean; onDirtyChange?: (dirty: boolean, busy: boolean) => void };

function staleMessage(error: unknown) {
    return error instanceof ApiError && (error.reason === "conflict" || error.status === 409);
}

function isDirty(draft: ChapterDraft) {
    return draft.text !== draft.baseline || draft.title !== draft.baselineTitle;
}

function metadataKey(format: DramaSourceFormat, selected: string[]) {
    return JSON.stringify([format, [...selected].sort()]);
}

export function WorkflowSourceReview(props: SourceProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <SourceReview key={`${userId}:${props.summary.project.id}`} {...props} userId={userId} />;
}

function SourceReview({ summary, onChanged, busy = false, onDirtyChange, userId }: SourceProps & { userId: string }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const projectId = summary.project.id;
    const configuring = (summary.guide?.step || summary.production.guideStep) === "configuring";
    const revision = summary.production.revision;
    const serverFormat: DramaSourceFormat = ["novel", "script", "storyboard"].includes(summary.project.sourceType) ? (summary.project.sourceType as DramaSourceFormat) : summary.episodes[0]?.sourceFormat || "novel";
    const [selectedId, setSelectedId] = useState("");
    const [drafts, setDrafts] = useState<Record<string, ChapterDraft>>({});
    const [metadata, setMetadata] = useState<MetadataDraft | null>(null);
    const [replacement, setReplacement] = useState<Replacement | null>(null);
    const [reading, setReading] = useState(false);
    const [reloading, setReloading] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const mounted = useRef(false);
    const readGeneration = useRef(0);
    const latest = useRef({ onChanged, onDirtyChange, chapterId: "" });
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
    const chapterId = chapters.data?.chapters.some((chapter) => chapter.id === selectedId) ? selectedId : chapters.data?.chapters[0]?.id || "";
    latest.current = { onChanged, onDirtyChange, chapterId };
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
        const selected = chapters.data.chapters.filter((chapter) => !chapter.reserved).map((chapter) => chapter.id);
        const baseline = metadataKey(serverFormat, selected);
        setMetadata((old) => {
            if (old && metadataKey(old.format, old.selected) !== old.baseline) return old;
            if (old?.baseline === baseline && old.revision === revision) return old;
            return { format: serverFormat, selected, baseline, revision };
        });
    }, [chapters.data, serverFormat, revision, metadata === null]);

    const draft = drafts[chapterId];
    const chapterDirty = Boolean(draft && isDirty(draft));
    const metadataDirty = Boolean(metadata && metadataKey(metadata.format, metadata.selected) !== metadata.baseline);
    const dirty = Object.values(drafts).some(isDirty) || metadataDirty || Boolean(replacement);
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
            if (latest.current.chapterId === input.id) message.success("已保存本章");
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
            if (input.revision !== revision) throw new Error("正文已有更新，请重新载入制作范围后再保存");
            const selectedChapters = chapters.data?.chapters.flatMap((chapter, index) => (input.selected.includes(chapter.id) ? [index] : [])) || [];
            if (!selectedChapters.length) throw new Error("请至少选择一章参与本次制作");
            if (selectedChapters.some((index) => chapters.data!.chapters[index].wordCount > EPISODE_SOURCE_CHARS)) throw new Error("本次制作的单章不能超过 1.2 万字，请先拆分或缩短正文");
            return saveDramaGuideSource(projectId, { expectedRevision: input.revision, sourceFormat: input.format, selectedChapters });
        },
        onSuccess: () => {
            if (!current()) return;
            setMetadata(null);
            setDrafts({});
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter"] });
            refresh();
            message.success("已保存素材类型与制作范围");
        },
        onError: (error) => {
            if (current()) message.error(staleMessage(error) ? "正文已被更新，未保存制作范围，请重新载入。" : error instanceof Error ? error.message : "保存失败");
        },
    });

    const replace = useMutation({
        mutationFn: async (input: Replacement) => {
            if (!current()) throw new Error("登录状态已变更，请重新操作");
            if (input.revision !== revision) throw new Error("正文已有更新，请重新上传后再替换");
            if (!input.selected.length) throw new Error("请至少选择一章参与本次制作");
            if (input.selected.some((index) => sourceChars(input.chapters[index].text) > EPISODE_SOURCE_CHARS)) throw new Error("本次制作的单章不能超过 1.2 万字，请调整选择或拆分正文");
            return saveDramaGuideSource(projectId, { expectedRevision: input.revision, chapters: input.chapters, sourceFormat: metadata?.format || serverFormat, selectedChapters: input.selected });
        },
        onSuccess: () => {
            if (!current()) return;
            setDrafts({});
            setMetadata(null);
            setSelectedId("");
            setReplacement(null);
            void queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter"] });
            refresh();
            message.success("已用新文件替换正文");
        },
        onError: (error) => {
            if (current()) message.error(staleMessage(error) ? "正文已被更新，未替换。请重新上传后再试。" : error instanceof Error ? error.message : "替换失败");
        },
    });

    const working = busy || reading || reloading || save.isPending || replace.isPending || saveMetadata.isPending;
    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, working);
    }, [dirty, working]);

    const loadReplacement = async (file: File) => {
        const generation = ++readGeneration.current;
        setReading(true);
        try {
            const content = await readDramaSourceFile(file);
            if (!current() || generation !== readGeneration.current) return;
            const parsed = analyzeNovel(content, { perEpisode: true }).chapters.map(({ title, text }) => ({ title, text }));
            if (!parsed.length) throw new Error("新文件里没有可导入的正文");
            if (parsed.some((chapter) => sourceChars(chapter.text) > MAX_CHAPTER_WORDS)) throw new Error("新文件单章超过 6 万字，请拆分后再导入");
            setReplacement({ fileName: file.name, chapters: parsed, selected: [0], revision });
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
    const download = () => {
        if (!draft) return;
        const url = URL.createObjectURL(new Blob([`# ${draft.title}\n\n${draft.text}`], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${draft.title || "正文"}.md`;
        link.click();
        URL.revokeObjectURL(url);
    };

    return (
        <section className="drama-workflow-source" aria-label="确认正文与拆集">
            <header className="drama-workflow-source-head">
                <div>
                    <h2>确认正文与拆集</h2>
                    <p>共 {chapters.data?.chapters.length ?? summary.production.chapterCount} 章。勾选本次制作范围，其余章节保留；集数按拆集配置生成，制作章节不超过 1.2 万字。</p>
                </div>
                <div className="drama-workflow-source-actions">
                    <Button icon={<Download className="size-3.5" />} disabled={!draft} onClick={download}>
                        下载本章
                    </Button>
                    {configuring ? (
                        <Button icon={<Replace className="size-3.5" />} disabled={working || dirty} loading={reading} onClick={() => fileRef.current?.click()}>
                            用新文件替换
                        </Button>
                    ) : null}
                </div>
            </header>
            {configuring ? (
                <SourceFormatPicker value={metadata?.format || serverFormat} disabled={!metadata || working || Boolean(replacement)} row onChange={(format) => setMetadata((old) => (old ? { ...old, format } : old))} />
            ) : (
                <p className="drama-workflow-note">配置已确认。保存单章正文不会自动重新改编已有剧本。</p>
            )}
            {configuring && metadata ? (
                <div className="drama-workflow-editor-bar">
                    <span>
                        本次制作 {metadata.selected.length} 章，其余预留。{metadataDirty ? "素材类型或制作范围有未保存的修改。" : ""}
                    </span>
                    {metadata.revision !== revision && metadataDirty ? (
                        <Button
                            disabled={working}
                            onClick={() => {
                                setMetadata(null);
                                void chapters.refetch();
                            }}
                        >
                            重新载入制作范围
                        </Button>
                    ) : (
                        <div className="drama-workflow-source-actions">
                            {metadataDirty ? (
                                <Button disabled={working} onClick={() => setMetadata(null)}>
                                    还原类型与范围
                                </Button>
                            ) : null}
                            <Button disabled={working || !metadataDirty || !metadata.selected.length || Object.values(drafts).some(isDirty) || Boolean(replacement)} loading={saveMetadata.isPending} onClick={() => saveMetadata.mutate(metadata)}>
                                保存类型与制作范围
                            </Button>
                        </div>
                    )}
                </div>
            ) : null}
            {replacement ? (
                <div className="drama-workflow-note" aria-label="替换正文预览">
                    <h3>替换预览：{replacement.fileName}</h3>
                    <p>解析出 {replacement.chapters.length} 章，默认仅制作第一章。确认后会替换原正文与待制作分集。</p>
                    {replacement.chapters.map((chapter, index) => (
                        <label key={index} className="drama-workflow-replacement-chapter">
                            <input
                                type="checkbox"
                                aria-label={`替换范围 ${chapter.title}`}
                                checked={replacement.selected.includes(index)}
                                disabled={working}
                                onChange={(event) => setReplacement({ ...replacement, selected: event.target.checked ? [...replacement.selected, index].sort((a, b) => a - b) : replacement.selected.filter((item) => item !== index) })}
                            />
                            {chapter.title} · {sourceChars(chapter.text).toLocaleString()} 字{sourceChars(chapter.text) > EPISODE_SOURCE_CHARS ? "（仅可预留）" : ""}
                        </label>
                    ))}
                    <div className="drama-workflow-source-actions">
                        <Button disabled={working} onClick={() => setReplacement(null)}>
                            取消替换
                        </Button>
                        <Button type="primary" disabled={working || !replacement.selected.length} loading={replace.isPending} onClick={() => replace.mutate(replacement)}>
                            确认替换正文
                        </Button>
                    </div>
                </div>
            ) : null}
            <div className="drama-workflow-source-body">
                <div className="drama-workflow-chapters thin-scrollbar" role="listbox" aria-label="章节列表">
                    <p>{chapters.data ? `共 ${chapters.data.chapters.length} 章` : "正在读取章节"}</p>
                    {chapters.data?.chapters.map((chapter) => (
                        <div key={chapter.id}>
                            {configuring && metadata ? (
                                <label>
                                    <input
                                        type="checkbox"
                                        aria-label={`本次制作 ${chapter.title}`}
                                        checked={metadata.selected.includes(chapter.id)}
                                        disabled={working || Boolean(replacement)}
                                        onChange={(event) => setMetadata({ ...metadata, selected: event.target.checked ? [...metadata.selected, chapter.id] : metadata.selected.filter((id) => id !== chapter.id) })}
                                    />
                                    本次制作
                                </label>
                            ) : null}
                            <button type="button" role="option" aria-selected={chapter.id === chapterId} onClick={() => setSelectedId(chapter.id)}>
                                <strong>
                                    {drafts[chapter.id]?.title || chapter.title || "未命名章节"}
                                    {drafts[chapter.id] && isDirty(drafts[chapter.id]) ? " · 未保存" : ""}
                                </strong>
                                <span>
                                    {chapter.wordCount.toLocaleString()} 字{chapter.reserved ? " · 预留" : chapter.episodeNumber ? ` · 第 ${chapter.episodeNumber} 集` : ""}
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
                </div>
                <div className="drama-workflow-editor">
                    {source.isError && !draft ? (
                        <p role="alert">
                            本章正文读取失败。
                            <Button size="small" type="link" onClick={() => void source.refetch()}>
                                重试
                            </Button>
                        </p>
                    ) : draft ? (
                        <>
                            <Input aria-label="章节标题" value={draft.title} disabled={working || Boolean(replacement)} onChange={(event) => setDrafts({ ...drafts, [chapterId]: { ...draft, title: event.target.value } })} />
                            <Input.TextArea aria-label="章节正文" value={draft.text} disabled={working || Boolean(replacement)} onChange={(event) => setDrafts({ ...drafts, [chapterId]: { ...draft, text: event.target.value } })} />
                            <div className="drama-workflow-editor-bar">
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
                                    <div className="drama-workflow-source-actions">
                                        {chapterDirty ? (
                                            <Button disabled={working || Boolean(replacement)} onClick={() => setDrafts({ ...drafts, [chapterId]: { ...draft, text: draft.baseline, title: draft.baselineTitle } })}>
                                                放弃本章修改
                                            </Button>
                                        ) : null}
                                        <Button type="primary" icon={<Save className="size-3.5" />} disabled={working || !chapterDirty || tooLong || Boolean(replacement)} loading={save.isPending} onClick={() => save.mutate(draft)}>
                                            保存本章
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <p role="status">{chapterId ? "正在读取正文…" : "还没有可确认的章节"}</p>
                    )}
                </div>
            </div>
            <input
                ref={fileRef}
                type="file"
                className="drama-workflow-file-input"
                accept=".txt,.md,.markdown,.docx,text/plain,text/markdown"
                aria-label="替换正文文件"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadReplacement(file);
                    event.target.value = "";
                }}
            />
        </section>
    );
}
