import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Checkbox, Input } from "antd";
import { AlertTriangle, FileUp, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { decodeNovelText } from "@/lib/canvas/canvas-document";
import { EPISODE_SOURCE_CHARS, sourceChars } from "@/lib/drama/novel-parse";
import { getActiveUserScope } from "@/lib/user-scope";
import { addDramaEpisode, getDramaChapter, updateDramaChapter, updateDramaEpisode, type DramaChapterRef, type DramaSourceFormat } from "@/services/api/drama";
import { useUserStore } from "@/stores/use-user-store";

import { formatCount, SOURCE_FORMAT_LABEL, SourceFormatPicker } from "../drama-shared";
import { useDramaOperationScope } from "./use-drama-operation-scope";

// 逐集制作：在作品末尾追加一集、插到某一集前后，或修改某一集的原文与素材类型。原文修改后需要重新改编才会重写剧本。

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv)$/i;

function useTextFile(onText: (text: string, fileName: string) => void, disabled = false) {
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const generation = useRef(0);
    const current = useRef({ onText, disabled, mounted: true });
    current.current.onText = onText;
    current.current.disabled = disabled;
    useEffect(() => {
        current.current.mounted = true;
        return () => {
            current.current.mounted = false;
        };
    }, []);
    const read = async (file: File) => {
        if (current.current.disabled) return;
        const request = ++generation.current;
        if (!TEXT_FILE.test(file.name)) {
            message.warning("支持 TXT、Markdown、CSV、TSV 文本文件");
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            message.warning("单集文件不超过 2MB");
            return;
        }
        try {
            const text = decodeNovelText(await file.arrayBuffer());
            if (request === generation.current && current.current.mounted && !current.current.disabled) current.current.onText(text, file.name);
        } catch {
            if (request === generation.current && current.current.mounted) message.warning("文件读取失败，请重新选择文件");
        }
    };
    const input = (
        <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,.markdown,.csv,.tsv,text/plain,text/markdown"
            className="hidden"
            disabled={disabled}
            onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void read(file);
            }}
        />
    );
    return { input, open: () => inputRef.current?.click(), read, cancel: () => generation.current++ };
}

function CharCounter({ chars, limit }: { chars: number; limit: number }) {
    const over = chars > limit;
    return (
        <span className={`drama-composer-count ${over ? "is-over" : ""}`}>
            {formatCount(chars)} / {formatCount(limit)} 字{over ? " · 超出部分会丢台词，请拆成多集" : ""}
        </span>
    );
}

/** 原文编辑弹窗外壳：左栏放标题、素材类型和格式说明，右侧整块是原文编辑区，可直接拖入文件。 */
function SourceComposer({
    open,
    title,
    subtitle,
    format,
    onFormat,
    side,
    text,
    onText,
    loading,
    busy = false,
    notice,
    footer,
    onClose,
}: {
    open: boolean;
    title: string;
    subtitle: string;
    format: DramaSourceFormat;
    onFormat: (format: DramaSourceFormat) => void;
    side?: ReactNode;
    text: string;
    onText: (text: string, fileName?: string) => void;
    loading?: boolean;
    busy?: boolean;
    notice?: ReactNode;
    footer: ReactNode;
    onClose: () => void;
}) {
    const [dragOver, setDragOver] = useState(false);
    const file = useTextFile(onText, busy);
    const onDrop = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        setDragOver(false);
        const dropped = event.dataTransfer.files?.[0];
        if (dropped && !busy) void file.read(dropped);
    };
    return (
        <AppModal open={open} onCancel={onClose} footer={null} title={null} closable={false} maskClosable={!busy} keyboard={!busy} flush centered width="min(1120px, calc(100vw - 48px))" rootClassName="drama-root" aria-label={title}>
            <div className="drama-composer">
                <header className="drama-composer-head">
                    <div className="min-w-0">
                        <strong>{title}</strong>
                        <span>{subtitle}</span>
                    </div>
                    <Button type="text" icon={<X className="size-4" />} aria-label="关闭" disabled={busy} onClick={onClose} />
                </header>
                <div className="drama-composer-body">
                    <aside className="drama-composer-side thin-scrollbar">
                        {side}
                        <div className="drama-composer-field">
                            <span className="drama-composer-label">素材类型</span>
                            <SourceFormatPicker value={format} onChange={onFormat} disabled={busy} />
                        </div>
                        <div className="drama-composer-guide">
                            <span className="drama-composer-label">{SOURCE_FORMAT_LABEL[format].title}怎么写</span>
                            <ul>
                                {SOURCE_FORMAT_LABEL[format].guide.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                        </div>
                        <Button block icon={<FileUp className="size-4" />} disabled={busy} onClick={file.open}>
                            从文件导入
                        </Button>
                        {file.input}
                    </aside>
                    <section
                        className={`drama-composer-editor ${dragOver ? "is-over" : ""}`}
                        onDragOver={(event) => {
                            event.preventDefault();
                            if (!busy) setDragOver(true);
                        }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={onDrop}
                    >
                        {notice}
                        <Input.TextArea
                            className="drama-composer-text thin-scrollbar"
                            value={loading ? "" : text}
                            disabled={loading || busy}
                            placeholder={loading ? "正在读取原文…" : `${SOURCE_FORMAT_LABEL[format].placeholder}\n\n也可以把 TXT / Markdown 文件拖到这里。`}
                            aria-label="本集原文"
                            onChange={(event) => {
                                file.cancel();
                                onText(event.target.value);
                            }}
                        />
                    </section>
                </div>
                <footer className="drama-composer-foot">{footer}</footer>
            </div>
        </AppModal>
    );
}

/** 插入位置：放到锚点集之前或之后，新集取得的集号就是 nextNumber，后续各集顺延。 */
export type EpisodePlacement = { anchorId: string; anchorNumber: number; position: "before" | "after" };

type AddEpisodeProps = {
    open: boolean;
    projectId: string;
    expectedRevision: number;
    nextNumber: number;
    createDraft?: boolean;
    /** 不传时追加到末尾。 */
    placement?: EpisodePlacement;
    defaultFormat: DramaSourceFormat;
    blockedReason?: string;
    onClose: () => void;
    onAdded: (episodeId: string) => void;
    onDirtyChange?: (dirty: boolean, busy?: boolean) => void;
};

export function AddEpisodeModal(props: AddEpisodeProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    const scope = getActiveUserScope();
    return props.open ? <AddEpisodeSession key={`${userId}:${scope}:${props.projectId}`} {...props} userId={userId} scope={scope} /> : null;
}

function AddEpisodeSession({ projectId, expectedRevision, nextNumber, createDraft, placement, defaultFormat, blockedReason, onClose, onAdded, onDirtyChange, userId, scope }: AddEpisodeProps & { userId: string; scope: string }) {
    const { message, modal } = App.useApp();
    const operation = useDramaOperationScope(projectId);
    const [title, setTitle] = useState("");
    const [format, setFormat] = useState<DramaSourceFormat>(defaultFormat);
    const [text, setText] = useState("");
    const [revision] = useState(expectedRevision);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [needsReview, setNeedsReview] = useState(false);
    const lock = useRef(false);
    const closeConfirm = useRef<{ destroy: () => void } | null>(null);
    const latest = useRef({ onClose, onAdded, onDirtyChange });
    latest.current = { onClose, onAdded, onDirtyChange };
    const ownerActive = Boolean(userId && userId === scope);
    const dirty = Boolean(title || text || format !== defaultFormat);
    const problem = !ownerActive ? "登录状态已变化，请关闭后重新打开。" : needsReview ? "请先核对分集列表，再重新打开新建分集，避免重复添加。" : expectedRevision !== revision ? "作品已有更新，请关闭后重新打开，核对最新分集。" : blockedReason;
    const formLocked = submitting || !ownerActive || needsReview || expectedRevision !== revision;
    useEffect(() => {
        latest.current.onDirtyChange?.(dirty, submitting);
    }, [dirty, submitting]);
    useEffect(
        () => () => {
            closeConfirm.current?.destroy();
            latest.current.onDirtyChange?.(false, false);
        },
        [],
    );
    useEffect(() => {
        if (submitting) {
            closeConfirm.current?.destroy();
            closeConfirm.current = null;
        }
    }, [submitting]);
    const chars = sourceChars(text);
    const add = async () => {
        if (lock.current || formLocked || problem || !chars || chars > EPISODE_SOURCE_CHARS) return;
        lock.current = true;
        setSubmitting(true);
        setError("");
        const ticket = operation.capture();
        try {
            const detail = await addDramaEpisode(projectId, {
                title: title.trim(),
                text,
                sourceFormat: format,
                expectedRevision: revision,
                ...(createDraft ? { createDraft } : {}),
                ...(placement ? { anchorEpisodeId: placement.anchorId, position: placement.position } : {}),
            });
            if (!operation.isCurrent(ticket)) return;
            message.success(`已${placement ? "插入" : "新建"}第 ${detail.episode.number} 集`);
            latest.current.onDirtyChange?.(false, false);
            latest.current.onAdded(detail.episode.id);
        } catch (reason) {
            if (!operation.isCurrent(ticket)) return;
            setError(reason instanceof Error ? reason.message : "提交结果未确认");
            setNeedsReview(true);
        } finally {
            lock.current = false;
            if (operation.isCurrent(ticket)) setSubmitting(false);
        }
    };
    const close = () => {
        if (lock.current || closeConfirm.current) return;
        if (!dirty) return latest.current.onClose();
        const ticket = operation.capture();
        closeConfirm.current = modal.confirm({
            title: "放弃本次分集草稿？",
            content: "尚未提交的标题和原文将不再保留。",
            onCancel: () => {
                closeConfirm.current = null;
            },
            onOk: () => {
                closeConfirm.current = null;
                if (operation.isCurrent(ticket) && !lock.current) latest.current.onClose();
            },
        });
    };
    return (
        <SourceComposer
            open
            busy={formLocked}
            title={placement ? `在第 ${placement.anchorNumber} 集${placement.position === "before" ? "前" : "后"}插入一集` : `新建分集 · 第 ${nextNumber} 集`}
            subtitle={placement ? `新的一集成为第 ${nextNumber} 集，后面各集集号顺延；已做好的集内容不受影响` : "一次只放这一集的内容，前面已做好的集不会受影响"}
            format={format}
            onFormat={setFormat}
            text={text}
            onText={(value, fileName) => {
                setText(value);
                if (fileName && !title) setTitle(fileName.replace(/\.[^.]+$/, "").slice(0, 60));
            }}
            onClose={close}
            side={
                <label className="drama-composer-field">
                    <span className="drama-composer-label">集标题</span>
                    <Input value={title} disabled={formLocked} maxLength={60} placeholder={`留空为“第 ${nextNumber} 集”`} aria-label="集标题" onChange={(event) => setTitle(event.target.value)} />
                </label>
            }
            notice={
                <>
                    {problem ? (
                        <div className="drama-composer-notice" role="alert">
                            <AlertTriangle className="size-4 shrink-0" />
                            {problem}
                        </div>
                    ) : null}
                    {error ? <p role="alert">{error}</p> : null}
                </>
            }
            footer={
                <>
                    <CharCounter chars={chars} limit={EPISODE_SOURCE_CHARS} />
                    <span className="flex-1" />
                    <Button disabled={submitting} onClick={close}>
                        取消
                    </Button>
                    <Button type="primary" loading={submitting} disabled={formLocked || Boolean(problem) || !chars || chars > EPISODE_SOURCE_CHARS} onClick={() => void add()}>
                        {placement ? "插入分集" : "新建分集"}
                    </Button>
                </>
            }
        />
    );
}

export function SourceEditModal({
    open,
    projectId,
    episodeId,
    episodeFormat,
    chapter,
    onClose,
    onSaved,
}: {
    open: boolean;
    projectId: string;
    episodeId: string;
    episodeFormat: DramaSourceFormat;
    chapter?: DramaChapterRef;
    onClose: () => void;
    onSaved: (rescript: boolean) => void;
}) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const queryKey = ["drama", projectId, "chapter", chapter?.id || ""];
    const query = useQuery({ queryKey, queryFn: ({ signal }) => getDramaChapter(projectId, chapter!.id, signal), enabled: open && Boolean(chapter), staleTime: 300_000 });
    const original = query.data?.chapter.sourceText || "";
    const [text, setText] = useState("");
    const [format, setFormat] = useState<DramaSourceFormat>(episodeFormat);
    const [rescript, setRescript] = useState(true);
    useEffect(() => {
        if (!open) return;
        setText(original);
        setFormat(episodeFormat);
        setRescript(true);
    }, [episodeFormat, open, original]);
    const limit = Math.max(EPISODE_SOURCE_CHARS, sourceChars(original));
    const chars = sourceChars(text);
    const changed = text !== original || format !== episodeFormat;
    const save = useMutation({
        mutationFn: async () => {
            if (chapter && text !== original) await updateDramaChapter(projectId, chapter.id, { text });
            if (format !== episodeFormat) await updateDramaEpisode(projectId, episodeId, { sourceFormat: format });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey });
            message.success(rescript ? "原文已保存，正在按新原文重新改编" : "原文已保存，点“重新改编”后生效");
            onSaved(rescript);
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });
    return (
        <SourceComposer
            open={open}
            title={chapter ? `编辑原文 · ${chapter.title}` : "编辑原文"}
            subtitle="改的是这一章的原文；已写好的剧本保持不变，重新改编后才按新原文重写"
            format={format}
            onFormat={setFormat}
            text={text}
            onText={(value) => setText(value)}
            loading={query.isLoading}
            onClose={onClose}
            footer={
                <>
                    <Checkbox checked={rescript} onChange={(event) => setRescript(event.target.checked)}>
                        保存后重新改编本集
                    </Checkbox>
                    <CharCounter chars={chars} limit={limit} />
                    <span className="flex-1" />
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" loading={save.isPending} disabled={!changed || !chars || chars > limit || query.isLoading} onClick={() => save.mutate()}>
                        {rescript ? "保存并重新改编" : "保存原文"}
                    </Button>
                </>
            }
        />
    );
}
