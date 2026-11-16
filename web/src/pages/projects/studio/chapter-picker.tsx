import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, InputNumber } from "antd";
import { AlertTriangle, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { groupChapterEpisodes } from "@/lib/drama/chapter-selection";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { EPISODE_GROUP_CHARS, EPISODE_SOURCE_CHARS } from "@/lib/drama/novel-parse";
import { getActiveUserScope } from "@/lib/user-scope";
import { getDrama, getDramaChapter, listDramaChapters, produceDramaChapters, type DramaSummary } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { ChapterPickList, type ChapterPickItem } from "../chapter-pick-list";
import { formatCount } from "../drama-shared";
import { useDramaOperationScope } from "./use-drama-operation-scope";

type Props = {
    open: boolean;
    summary: DramaSummary;
    blockedReason?: string;
    busy?: boolean;
    onClose: () => void;
    onProduced: (episodeIds: string[]) => void;
    onDirtyChange?: (dirty: boolean, busy?: boolean) => void;
};

export function ChapterPickerModal(props: Props) {
    const userId = useUserStore((state) => state.user?.id || "");
    const scope = getActiveUserScope();
    return props.open ? <ChapterPickerSession key={`${userId}:${scope}:${props.summary.project.id}`} {...props} userId={userId} scope={scope} /> : null;
}

function ChapterPickerSession({ summary, blockedReason, busy = false, onClose, onProduced, onDirtyChange, userId, scope }: Props & { userId: string; scope: string }) {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const projectId = summary.project.id;
    const operation = useDramaOperationScope(projectId);
    const [baseline, setBaseline] = useState(summary);
    const [picked, setPicked] = useState<Set<string>>(() => new Set());
    const [perEpisode, setPerEpisode] = useState<number>();
    const [previewId, setPreviewId] = useState<string>();
    const [submitting, setSubmitting] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [error, setError] = useState("");
    const [needsReload, setNeedsReload] = useState(false);
    const lock = useRef(false);
    const closeConfirm = useRef<{ destroy: () => void } | null>(null);
    const latest = useRef({ onClose, onProduced, onDirtyChange, busy, revision: summary.production.revision });
    latest.current = { onClose, onProduced, onDirtyChange, busy, revision: summary.production.revision };
    const ownerActive = Boolean(userId && userId === scope);
    const revision = baseline.production.revision;
    const stale = summary.production.revision !== revision;
    const key = [...dramaKeys.chapters(projectId), userId, scope, revision];
    const chaptersQuery = useQuery({ queryKey: key, queryFn: ({ signal }) => listDramaChapters(projectId, signal), enabled: ownerActive });
    const chapters = chaptersQuery.data?.chapters || [];
    const sourceFormat = baseline.project.sourceType || baseline.episodes[0]?.sourceFormat || "novel";
    const fixedSize = sourceFormat === "script" || sourceFormat === "storyboard";
    const defaultSize = fixedSize ? 1 : Math.max(1, baseline.production.settings.chaptersPerEpisode || 1);
    const size = fixedSize ? 1 : (perEpisode ?? defaultSize);
    const stage = summary.guide?.step || summary.production.guideStep;
    const stageBlocker = stage === "configuring" ? "请先在剧本格式中选择制作范围并确认风格。" : !summary.production.planDone ? "前面的章节还在分集规划，完成后再加入。" : "";
    const selected = new Set(chapters.flatMap((chapter, index) => (picked.has(chapter.id) && chapter.reserved ? [index] : [])));
    const chosen = [...selected].sort((left, right) => left - right);
    const groups = groupChapterEpisodes(
        chosen.map((index) => ({ position: chapters[index].position, chars: chapters[index].wordCount })),
        size,
    );
    const longChapters = chosen.filter((index) => chapters[index].wordCount > EPISODE_SOURCE_CHARS).length;
    const oversized = groups.find((group) => group.chars > EPISODE_GROUP_CHARS);
    const dirty = picked.size > 0 || size !== defaultSize;
    const working = submitting || reloading;
    const problem = !ownerActive
        ? "登录状态已变化，请关闭后重新打开。"
        : stale || needsReload
          ? "章节或制作设置已有更新，请重新载入后核对选择。"
          : blockedReason || stageBlocker || (longChapters ? `选中的 ${longChapters} 章超过 ${EPISODE_SOURCE_CHARS / 10_000} 万字，请先拆分或取消选中。` : oversized ? `${oversized.label}合计 ${formatCount(oversized.chars)} 字，请减少每集章数。` : "");
    const formLocked = busy || working || stale || needsReload || !ownerActive;
    const disabled = formLocked || chaptersQuery.isFetching || chaptersQuery.isError || Boolean(problem);
    const items: ChapterPickItem[] = chapters.map((chapter) => ({
        key: chapter.id,
        title: chapter.title,
        words: chapter.wordCount,
        warn: chapter.reserved && chapter.wordCount > EPISODE_SOURCE_CHARS,
        disabled: !chapter.reserved,
        note: chapter.reserved ? "待加入制作" : chapter.episodeNumber ? `第 ${chapter.episodeNumber} 集` : "已加入制作",
    }));
    const preview = chapters.find((chapter) => chapter.id === previewId) || chapters.find((chapter) => chapter.reserved) || chapters[0];
    const previewIndex = chapters.findIndex((chapter) => chapter.id === preview?.id);
    const previewQuery = useQuery({ queryKey: [...key, "preview", preview?.id], queryFn: ({ signal }) => getDramaChapter(projectId, preview!.id, signal), enabled: ownerActive && Boolean(preview) });
    const reservedCount = chapters.filter((chapter) => chapter.reserved).length;

    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, working);
    }, [dirty, working]);
    useEffect(
        () => () => {
            closeConfirm.current?.destroy();
            latest.current.onDirtyChange?.(false, false);
        },
        [],
    );
    useEffect(() => {
        if (busy || working) {
            closeConfirm.current?.destroy();
            closeConfirm.current = null;
        }
    }, [busy, working]);
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ["drama", projectId] });
    const reload = async () => {
        if (lock.current || busy || !ownerActive) return;
        lock.current = true;
        setReloading(true);
        const ticket = operation.capture();
        try {
            const [next, outline] = await Promise.all([getDrama(projectId), listDramaChapters(projectId)]);
            if (!operation.isCurrent(ticket) || next.project.id !== projectId) return;
            const cached = queryClient.getQueryData<DramaSummary>(dramaKeys.summary(projectId));
            if (next.production.revision < Math.max(revision, latest.current.revision, cached?.production.revision || 0)) throw new Error("载入期间内容再次更新，请重新载入后核对。");
            queryClient.setQueryData(dramaKeys.summary(projectId), next);
            queryClient.setQueryData([...dramaKeys.chapters(projectId), userId, scope, next.production.revision], outline);
            void queryClient.invalidateQueries({ queryKey: [...dramaKeys.chapters(projectId), userId, scope, next.production.revision, "preview"] });
            setBaseline(next);
            setPicked((current) => new Set([...current].filter((id) => outline.chapters.some((chapter) => chapter.id === id && chapter.reserved))));
            setError("");
            setNeedsReload(false);
        } catch (reason) {
            if (operation.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "重新载入失败，请重试");
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setReloading(false);
        }
    };
    const produce = async () => {
        if (lock.current || disabled || !chosen.length) return;
        lock.current = true;
        setSubmitting(true);
        setError("");
        const ticket = operation.capture();
        const chapterIds = chosen.map((index) => chapters[index].id);
        try {
            const result = await produceDramaChapters(projectId, { chapterIds, chaptersPerEpisode: size, expectedRevision: revision });
            if (!operation.isCurrent(ticket)) return;
            void invalidate();
            message.success(`已加入 ${chapterIds.length} 章，新建 ${result.episodeIds.length} 集`);
            latest.current.onProduced(result.episodeIds);
        } catch (reason) {
            if (!operation.isCurrent(ticket)) return;
            setError(reason instanceof Error ? reason.message : "提交结果未确认，请重新载入章节核对后再操作。");
            setNeedsReload(true);
            void invalidate();
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setSubmitting(false);
        }
    };
    const close = () => {
        if (lock.current || busy || closeConfirm.current) return;
        if (!dirty) return latest.current.onClose();
        const ticket = operation.capture();
        closeConfirm.current = modal.confirm({
            title: "放弃本次选章？",
            content: "本次选择尚未提交，原文和已有剧集会保留。",
            onCancel: () => {
                closeConfirm.current = null;
            },
            onOk: () => {
                closeConfirm.current = null;
                if (operation.isCurrent(ticket) && !lock.current && !latest.current.busy) latest.current.onClose();
            },
        });
    };

    return (
        <AppModal open onCancel={close} footer={null} title={null} closable={false} maskClosable={!working && !busy} keyboard={!working && !busy} flush centered width="min(1120px, calc(100vw - 48px))" rootClassName="drama-root" aria-label="原著章节">
            <div className="drama-composer">
                <header className="drama-composer-head">
                    <div className="min-w-0">
                        <strong>继续选章</strong>
                        <span>勾选待加入的原文章节，确认后追加为新的制作集；已有集保持当前版本。</span>
                    </div>
                    <Button type="text" icon={<X className="size-4" aria-hidden />} aria-label="关闭选章" disabled={working || busy} onClick={close} />
                </header>
                <div className="drama-composer-body drama-chapter-picker-body">
                    <aside className="drama-chapter-picker-side">
                        {chaptersQuery.isPending ? (
                            <p role="status">正在读取原文目录…</p>
                        ) : chaptersQuery.isError ? (
                            <p role="alert">原文目录读取失败，请重新载入。</p>
                        ) : (
                            <fieldset disabled={formLocked}>
                                <ChapterPickList
                                    items={items}
                                    selected={selected}
                                    onChange={(next) => {
                                        if (formLocked) return;
                                        setPicked(new Set([...next].flatMap((index) => (chapters[index]?.reserved ? [chapters[index].id] : []))));
                                    }}
                                    previewIndex={previewIndex}
                                    onPreview={(index) => setPreviewId(chapters[index]?.id)}
                                    quickLabel="接下来"
                                />
                            </fieldset>
                        )}
                    </aside>
                    <section className="drama-composer-editor">
                        {problem ? (
                            <p className="drama-composer-notice" role="alert">
                                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                                {problem}
                            </p>
                        ) : null}
                        {error ? <p role="alert">{error}</p> : null}
                        <div className="drama-chapter-picker-preview thin-scrollbar" aria-label="原文预览">
                            {preview ? (
                                <>
                                    <h3>
                                        {preview.title}
                                        <small>
                                            {formatCount(preview.wordCount)} 字 · {preview.reserved ? "待加入制作" : `已加入${preview.episodeNumber ? `第 ${preview.episodeNumber} 集` : "制作"}`}
                                        </small>
                                    </h3>
                                    <p>{previewQuery.isPending ? "正在读取原文…" : previewQuery.isError ? "原文读取失败，请重新载入。" : (previewQuery.data?.chapter.sourceText || "").slice(0, 8000)}</p>
                                </>
                            ) : (
                                <p>没有原文章节</p>
                            )}
                        </div>
                    </section>
                </div>
                <footer className="drama-composer-foot">
                    <span className="drama-chapter-picker-size">
                        {fixedSize ? (
                            "每章一集"
                        ) : (
                            <>
                                每集
                                <InputNumber size="small" min={1} max={12} precision={0} value={size} disabled={formLocked} onChange={(value) => setPerEpisode(value || 1)} aria-label="每集章数" />章
                            </>
                        )}
                    </span>
                    <span className="drama-composer-count">
                        原文 {formatCount(chapters.length)} 章 · 已建 {formatCount(baseline.episodes.length)} 集 · 待加入 {formatCount(reservedCount)} 章 · 已选 {formatCount(chosen.length)} 章，将新建 {formatCount(groups.length)} 集
                    </span>
                    <span className="flex-1" />
                    <Button disabled={working || busy || !ownerActive} loading={reloading} onClick={() => void reload()}>
                        重新载入
                    </Button>
                    <Button disabled={working || busy} onClick={close}>
                        取消
                    </Button>
                    <Button type="primary" disabled={disabled || !chosen.length} loading={submitting} onClick={() => void produce()}>
                        加入制作
                    </Button>
                </footer>
            </div>
        </AppModal>
    );
}
