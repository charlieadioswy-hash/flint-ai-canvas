import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Select } from "antd";
import { ArrowDownWideNarrow, Clapperboard, Download, FileArchive, Film, Image, MoreVertical, Plus, Search } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { getDramaEpisode, getDramaWorkflowReadiness, renderDramaEpisode, type DramaEpisodeDetail, type DramaEpisodeRow, type DramaSummary } from "@/services/api/drama";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

import { downloadResource, episodeStatusText, episodeTone, formatDuration, MediaThumb, sourceFormatOf } from "./drama-shared";
import { AssetPackageModal } from "./studio/asset-transfer";
import { AddEpisodeModal } from "./studio/episode-source";
import { useDramaOperationScope } from "./studio/use-drama-operation-scope";
import { WorkflowBatch } from "./workflow-batch";
import { episodeWorkflowEntryStep } from "./workflow-state";
import "./workflow-episodes.css";

export type WorkflowEpisodesProps = {
    summary: DramaSummary;
    onChanged: () => void | Promise<unknown>;
    onOpenEpisode: (episodeId: string, step?: "review" | "story") => void;
    onPickChapters?: () => void;
    onDirtyChange?: (dirty: boolean, busy?: boolean) => void;
    busy?: boolean;
};

type Filter = "all" | "idle" | "active" | "failed" | "done";
type ProgressState = Exclude<Filter, "all"> | "unknown";
type ResultKind = "render" | "download";
type ResultItem = {
    episodeId: string;
    number: number;
    title: string;
    status: "ready" | "blocked" | "running" | "succeeded" | "failed" | "uncertain";
    note: string;
    revision?: number;
    resourceId?: string;
};
type ResultState = { kind: ResultKind; phase: "checking" | "ready" | "running" | "done"; items: ResultItem[]; error?: string; notice?: string };

const FILTERS: { value: Filter; label: string }[] = [
    { value: "idle", label: "未进行" },
    { value: "active", label: "进行中" },
    { value: "failed", label: "失败" },
    { value: "done", label: "完成" },
];

function matches(episode: DramaEpisodeRow, filter: Filter) {
    const tone = episodeTone(episode);
    if (filter === "failed") return tone === "error";
    if (filter === "idle") return tone === "idle";
    if (filter === "active") return tone === "active" || tone === "ready" || tone === "review" || episode.finalStale;
    if (filter === "done") return tone === "done";
    return true;
}

function subjectStatus(detail?: DramaEpisodeDetail) {
    if (!detail) return "勾选后检查";
    const references = new Map(
        detail.segments
            .flatMap((segment) => segment.request.references)
            .filter((reference) => reference.castId)
            .map((reference) => [reference.castId, reference]),
    );
    if (!references.size) return "无主体引用";
    const missing = [...references.values()].filter((reference) => !reference.resourceId).length;
    return missing ? `缺少 ${missing} 项参考图` : `已引用 ${references.size} 项`;
}

function subjectState(detail?: DramaEpisodeDetail): ProgressState {
    if (!detail) return "unknown";
    if (!detail.segments.length) return "idle";
    return detail.segments.some((segment) => segment.request.references.some((reference) => reference.castId && !reference.resourceId)) ? "idle" : "done";
}

function storyboardState(episode: DramaEpisodeRow): ProgressState {
    if (episode.stage === "script") return episode.error ? "failed" : "active";
    if (episode.shotCount > 0) return "done";
    return "idle";
}

function videoState(episode: DramaEpisodeRow): ProgressState {
    if ((episode.error || episode.stats.failed > 0) && (episode.stage === "video" || episode.stage === "render")) return "failed";
    if (!episode.finalStale && ((episode.finalResourceId && episode.stage === "done") || (episode.stats.segments > 0 && episode.stats.videoReady >= episode.stats.segments))) return "done";
    return episode.finalStale || episode.stats.videoReady > 0 || episode.stats.videoGenerated > 0 || episode.stage === "render" ? "active" : "idle";
}

function updatedTime(episode: DramaEpisodeRow) {
    const time = Date.parse(episode.updatedAt || "");
    return Number.isFinite(time) ? time : 0;
}

const DRAMA_TYPE_LABEL = { comic: "精品漫", live_action: "真人剧", narration: "漫剧解说" };
const PROGRESS_LABEL: Record<ProgressState, string> = { idle: "未进行", active: "进行中", failed: "失败", done: "完成", unknown: "尚未检查" };

export function WorkflowEpisodes(props: WorkflowEpisodesProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <WorkflowEpisodesSession key={`${userId}:${props.summary.project.id}`} {...props} userId={userId} />;
}

function WorkflowEpisodesSession({ summary, onChanged, onOpenEpisode, onPickChapters, onDirtyChange, busy: externalBusy = false, userId }: WorkflowEpisodesProps & { userId: string }) {
    const projectId = summary.project.id;
    const client = useQueryClient();
    const operation = useDramaOperationScope(projectId);
    const [search, setSearch] = useState("");
    const query = useDeferredValue(search.trim().toLocaleLowerCase());
    const [filter, setFilter] = useState<Filter>("all");
    const [sortBy, setSortBy] = useState<"updated" | "number">("updated");
    const [descending, setDescending] = useState(true);
    const [selection, setSelection] = useState<Set<string>>(() => new Set());
    const [adding, setAdding] = useState(false);
    const [addingState, setAddingState] = useState({ dirty: false, busy: false });
    const addingChanged = useCallback((dirty: boolean, busy = false) => setAddingState((current) => (current.dirty === dirty && current.busy === busy ? current : { dirty, busy })), []);
    const [exporting, setExporting] = useState(false);
    const [result, setResult] = useState<ResultState>();
    const [batchBusy, setBatchBusy] = useState(false);
    const locked = useRef(false);
    const latest = useRef({ summary, onChanged, onOpenEpisode });
    latest.current = { summary, onChanged, onOpenEpisode };
    const creationTicket = useRef<ReturnType<typeof operation.capture> | undefined>(undefined);
    const selected = summary.episodes.filter((episode) => selection.has(episode.id));
    const scopeSignature = JSON.stringify(selected.map((episode) => episode.id).sort());
    const jobsActive = Boolean(summary.jobCounts.queued || summary.jobCounts.running);
    const details = useQueries({
        queries: selected.map((episode) => ({
            queryKey: [...dramaKeys.episode(projectId, episode.id), "management", userId, summary.production.revision],
            queryFn: ({ signal }: { signal: AbortSignal }) => getDramaEpisode(projectId, episode.id, signal),
            refetchInterval: jobsActive ? 3000 : false,
        })),
    });
    const scopeLoading = details.some((detail) => detail.isPending);
    const scopeFailed = details.some((detail) => detail.isError);
    const currentDetails = details.flatMap((detail, index) => (detail.data?.episode.id === selected[index]?.id && detail.data.episode.projectId === projectId ? [detail.data] : []));
    const scopeComplete = selected.length > 0 && !scopeLoading && !scopeFailed && currentDetails.length === selected.length;
    const segmentIds = scopeComplete ? [...new Set(currentDetails.flatMap((detail) => detail.segments.map((segment) => segment.id)))] : [];
    const targetLabels = Object.fromEntries(currentDetails.flatMap((detail) => detail.segments.map((segment) => [segment.id, `第 ${detail.episode.number} 集 · 第 ${segment.index + 1} 段`])));
    const byId = new Map(currentDetails.map((detail) => [detail.episode.id, detail]));
    const visible = useMemo(
        () =>
            summary.episodes
                .filter((episode) => matches(episode, filter) && (!query || `${episode.number} ${episode.title} ${episode.synopsis}`.toLocaleLowerCase().includes(query)))
                .sort((left, right) => {
                    const order = (sortBy === "updated" ? updatedTime(left) - updatedTime(right) : 0) || left.number - right.number;
                    return descending ? -order : order;
                }),
        [summary.episodes, filter, query, descending, sortBy],
    );
    const counts = Object.fromEntries(FILTERS.map(({ value }) => [value, summary.episodes.filter((episode) => matches(episode, value)).length]));
    const busy = result?.phase === "checking" || result?.phase === "running" || batchBusy || addingState.busy;
    const viewLocked = Boolean(result) || batchBusy || addingState.busy || externalBusy;
    useEffect(() => {
        onDirtyChange?.(addingState.dirty, busy);
    }, [addingState.dirty, busy, onDirtyChange]);
    useEffect(() => () => onDirtyChange?.(false, false), [onDirtyChange]);

    useEffect(() => {
        setSelection((current) => {
            const next = new Set([...current].filter((id) => summary.episodes.some((episode) => episode.id === id)));
            return next.size === current.size ? current : next;
        });
    }, [summary.episodes]);

    const refresh = async (ticket: ReturnType<typeof operation.capture>) => {
        if (!operation.isCurrent(ticket)) return;
        await Promise.all([
            client.invalidateQueries({ queryKey: dramaKeys.summary(projectId), exact: true }),
            client.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) }),
            client.invalidateQueries({ queryKey: dramaKeys.chapters(projectId) }),
            client.invalidateQueries({ queryKey: ["drama", projectId, "workflow-readiness"] }),
            Promise.resolve(latest.current.onChanged()),
        ]);
    };

    const prepare = async (kind: ResultKind, ids: string[], previous: ResultItem[] = []) => {
        if (locked.current) return;
        locked.current = true;
        const ticket = operation.capture();
        const rows = latest.current.summary.episodes.filter((episode) => ids.includes(episode.id)).sort((left, right) => left.number - right.number);
        const completed = new Map(previous.filter((item) => item.status === "succeeded").map((item) => [item.episodeId, item]));
        setResult({ kind, phase: "checking", items: rows.map((episode) => completed.get(episode.id) || { episodeId: episode.id, number: episode.number, title: episode.title, status: "blocked", note: "正在检查…" }) });
        try {
            const readiness = kind === "render" ? await getDramaWorkflowReadiness(projectId) : undefined;
            if (!operation.isCurrent(ticket)) return;
            const items: ResultItem[] = rows.map((episode) => {
                const done = completed.get(episode.id);
                if (done) return done;
                const base = { episodeId: episode.id, number: episode.number, title: episode.title };
                if (kind === "download")
                    return episode.finalResourceId ? { ...base, status: "ready", resourceId: episode.finalResourceId, note: episode.finalStale ? "当前为旧版成片，将下载这一版本" : "成片可下载" } : { ...base, status: "blocked", note: "尚无成片" };
                const ready = readiness?.episodes.find((item) => item.episodeId === episode.id);
                if (episode.finalResourceId && !episode.finalStale && episode.stage === "done") return { ...base, status: "blocked", note: "已有最新成片，无需重复合成" };
                if (!ready?.canRender || !Number.isSafeInteger(ready.revision) || ready.revision < 0) return { ...base, status: "blocked", note: ready?.blockingReason || "本集全部段视频尚未就绪，或正在制作中" };
                return { ...base, status: "ready", revision: ready.revision, note: `${ready.readyVideos} 段视频已就绪，可合成` };
            });
            setResult({ kind, phase: "ready", items });
        } catch (error) {
            if (operation.isCurrent(ticket)) setResult((current) => (current ? { ...current, phase: "ready", error: error instanceof Error ? error.message : "检查失败，请重新检查" } : current));
        } finally {
            locked.current = false;
        }
    };

    const execute = async () => {
        if (!result || result.phase !== "ready" || locked.current) return;
        const targets = result.items.filter((item) => item.status === "ready");
        if (!targets.length) return;
        locked.current = true;
        const ticket = operation.capture();
        const kind = result.kind;
        const projectName = summary.project.name;
        setResult((current) => (current ? { ...current, phase: "running", error: undefined } : current));
        const update = (id: string, patch: Partial<ResultItem>) => {
            if (operation.isCurrent(ticket)) setResult((current) => (current ? { ...current, items: current.items.map((item) => (item.episodeId === id ? { ...item, ...patch } : item)) } : current));
        };
        try {
            for (const item of targets) {
                if (!operation.isCurrent(ticket)) return;
                update(item.episodeId, { status: "running", note: kind === "render" ? "正在提交合成…" : "正在请求下载…" });
                try {
                    if (kind === "render") {
                        if (item.revision === undefined) throw new Error("本集版本缺失，请重新检查");
                        const receipt = await renderDramaEpisode(projectId, item.episodeId, { expectedRevision: item.revision });
                        update(item.episodeId, { status: "succeeded", note: receipt.jobs > 0 ? "已提交合成，可在制作队列查看进度" : "已有当前结果或合成任务，已跳过重复提交" });
                    } else {
                        if (!item.resourceId) throw new Error("成片资源已失效，请重新检查");
                        await downloadResource(item.resourceId, `${projectName}-第${item.number}集.mp4`);
                        update(item.episodeId, { status: "succeeded", note: "已发起下载，请在浏览器下载列表核对" });
                    }
                } catch (error) {
                    const rejected = kind === "download" || (error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
                    update(item.episodeId, { status: rejected ? "failed" : "uncertain", note: rejected ? (error instanceof Error ? error.message : "操作失败") : "提交结果待确认，请重新检查最新状态后再操作" });
                }
            }
            if (!operation.isCurrent(ticket)) return;
            if (kind === "render") {
                try {
                    await refresh(ticket);
                } catch (error) {
                    if (operation.isCurrent(ticket)) setResult((current) => (current ? { ...current, notice: `逐项回执已保留，刷新失败：${error instanceof Error ? error.message : "请稍后重试"}` } : current));
                }
            }
            if (operation.isCurrent(ticket)) setResult((current) => (current ? { ...current, phase: "done" } : current));
        } finally {
            locked.current = false;
        }
    };

    const toggle = (id: string) =>
        setSelection((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const readyCount = result?.items.filter((item) => item.status === "ready").length || 0;
    const succeededCount = result?.items.filter((item) => item.status === "succeeded").length || 0;
    const failedCount = result?.items.filter((item) => item.status === "failed" || item.status === "uncertain").length || 0;

    return (
        <section className="drama-workflow-episodes" aria-label="分集管理">
            <header className="drama-workflow-episodes-head">
                <div>
                    <h2>分集管理</h2>
                    {summary.production.reservedChapterCount > 0 ? (
                        <p>
                            原文 {summary.production.chapterCount + summary.production.reservedChapterCount} 章 · 制作 {summary.episodes.length} 集 · 待制作 {summary.production.reservedChapterCount} 章
                        </p>
                    ) : null}
                </div>
                <div className="drama-workflow-episodes-actions">
                    <Button
                        icon={<Clapperboard className="size-3.5" />}
                        disabled={viewLocked || !summary.episodes.length}
                        onClick={() =>
                            void prepare(
                                "render",
                                summary.episodes.map((episode) => episode.id),
                            )
                        }
                    >
                        合成全部就绪分集
                    </Button>
                    <Button
                        icon={<Download className="size-3.5" />}
                        disabled={viewLocked || !summary.episodes.some((episode) => episode.finalResourceId)}
                        onClick={() =>
                            void prepare(
                                "download",
                                summary.episodes.map((episode) => episode.id),
                            )
                        }
                    >
                        下载全部成片
                    </Button>
                    <Button icon={<FileArchive className="size-3.5" />} disabled={viewLocked} onClick={() => setExporting(true)}>
                        导出资产包
                    </Button>
                    {summary.production.reservedChapterCount > 0 && onPickChapters ? (
                        <Button disabled={viewLocked || adding || exporting} onClick={onPickChapters}>
                            继续选章
                        </Button>
                    ) : null}
                    <Button
                        type="primary"
                        icon={<Plus className="size-3.5" />}
                        disabled={viewLocked || adding || exporting || !summary.production.planDone}
                        title={!summary.production.planDone ? "请等待现有章节完成分集规划" : undefined}
                        onClick={() => {
                            creationTicket.current = operation.capture();
                            setAdding(true);
                        }}
                    >
                        新建分集
                    </Button>
                </div>
            </header>
            <div className="drama-workflow-episodes-toolbar">
                <div className="drama-workflow-episodes-selection">
                    <label>
                        <input
                            type="checkbox"
                            aria-label="选择当前筛选分集"
                            checked={visible.length > 0 && visible.every((episode) => selection.has(episode.id))}
                            disabled={viewLocked || !visible.length}
                            onChange={(event) => setSelection((current) => (event.target.checked ? new Set([...current, ...visible.map((episode) => episode.id)]) : new Set([...current].filter((id) => !visible.some((episode) => episode.id === id)))))}
                        />
                        共 {visible.length} 项
                    </label>
                    {selected.length ? (
                        <Button size="small" type="text" disabled={viewLocked} onClick={() => setSelection(new Set())}>
                            清空选择（{selected.length}）
                        </Button>
                    ) : null}
                </div>
                <div className="drama-workflow-episodes-filters" role="group" aria-label="筛选分集状态">
                    <span>分集状态：</span>
                    {FILTERS.map(({ value, label }) => (
                        <button
                            key={value}
                            type="button"
                            aria-label={`${label}分集`}
                            title={`${label} ${counts[value]} 集，再次点击显示全部`}
                            data-status={value}
                            aria-pressed={filter === value}
                            disabled={viewLocked}
                            onClick={() => setFilter(filter === value ? "all" : value)}
                        >
                            <span className="drama-workflow-episode-dot" aria-hidden />
                            {label}
                        </button>
                    ))}
                </div>
                <div className="drama-workflow-episodes-tools">
                    <Select
                        aria-label="分集排序方式"
                        value={sortBy}
                        onChange={setSortBy}
                        disabled={viewLocked}
                        options={[
                            { value: "updated", label: "按更新时间排序" },
                            { value: "number", label: "按集号排序" },
                        ]}
                    />
                    <Select
                        aria-label="分集排序"
                        value={descending ? "desc" : "asc"}
                        disabled={viewLocked}
                        onChange={(value) => setDescending(value === "desc")}
                        options={[
                            { value: "asc", label: "正序" },
                            { value: "desc", label: "倒序" },
                        ]}
                        suffixIcon={<ArrowDownWideNarrow className="size-3.5" />}
                    />
                    <Input aria-label="搜索分集" placeholder="搜索集号、标题或梗概" prefix={<Search className="size-3.5" aria-hidden />} allowClear disabled={viewLocked} value={search} onChange={(event) => setSearch(event.target.value)} />
                </div>
            </div>
            {selected.length ? (
                <section className="drama-workflow-episodes-batch" aria-label="已选分集批量制作" key={scopeSignature}>
                    <div>
                        <strong>范围：已选 {selected.length} 集的剧情段</strong>
                        <p>主体按镜头引用。批量生成以剧情段为单位；镜头独立素材请进入本集编辑。</p>
                    </div>
                    {scopeLoading ? (
                        <p role="status">正在读取所选分集的剧情段与主体引用…</p>
                    ) : scopeFailed ? (
                        <p role="alert">
                            部分分集读取失败，未开放批量提交。
                            <Button
                                size="small"
                                onClick={() =>
                                    details.forEach((detail) => {
                                        if (detail.isError) void detail.refetch();
                                    })
                                }
                            >
                                重试失败项
                            </Button>
                        </p>
                    ) : !scopeComplete ? (
                        <p role="alert">所选分集已有变化，请重新选择范围。</p>
                    ) : !segmentIds.length ? (
                        <p role="status">所选分集尚无剧情段，请先完成剧本与分镜。</p>
                    ) : (
                        <WorkflowBatch
                            projectId={projectId}
                            revision={summary.production.revision}
                            targetIds={segmentIds}
                            targetLabels={targetLabels}
                            actions={["segment_assets", "segment_prompt", "segment_video"]}
                            disabled={viewLocked}
                            onBusyChange={setBatchBusy}
                            onChanged={() => refresh(operation.capture())}
                        />
                    )}
                    <div className="drama-workflow-episodes-actions">
                        <Button
                            size="small"
                            disabled={viewLocked}
                            onClick={() =>
                                void prepare(
                                    "render",
                                    selected.map((episode) => episode.id),
                                )
                            }
                        >
                            合成已选就绪分集
                        </Button>
                        <Button
                            size="small"
                            disabled={viewLocked || !selected.some((episode) => episode.finalResourceId)}
                            onClick={() =>
                                void prepare(
                                    "download",
                                    selected.map((episode) => episode.id),
                                )
                            }
                        >
                            下载已选成片
                        </Button>
                    </div>
                </section>
            ) : null}
            {!visible.length ? (
                <div className="drama-workflow-episodes-empty" role="status">
                    <Film className="size-7" aria-hidden />
                    <strong>{summary.episodes.length ? "没有符合条件的分集" : "尚无分集"}</strong>
                    <p>{summary.episodes.length ? "调整状态筛选或搜索关键词。" : "完成剧本编排后，分集会显示在这里。"}</p>
                </div>
            ) : (
                <div className="drama-workflow-episodes-grid">
                    {visible.map((episode) => (
                        <article className={`drama-workflow-episode-card${selection.has(episode.id) ? " is-selected" : ""}`} key={episode.id} data-tone={episodeTone(episode)}>
                            <label className="drama-workflow-episode-check">
                                <input type="checkbox" aria-label={`选择第 ${episode.number} 集`} checked={selection.has(episode.id)} disabled={viewLocked} onChange={() => toggle(episode.id)} />
                                <span className="sr-only">选择第 {episode.number} 集</span>
                            </label>
                            <button className="drama-workflow-episode-open" type="button" aria-label={`打开第 ${episode.number} 集`} disabled={viewLocked} onClick={() => onOpenEpisode(episode.id, episodeWorkflowEntryStep(episode))}>
                                <div className="drama-workflow-episode-cover">
                                    <MediaThumb
                                        resourceId={episode.finalResourceId}
                                        alt={`第 ${episode.number} 集成片封面`}
                                        fallback={
                                            <span>
                                                <Image className="size-6" aria-hidden />
                                                {episode.finalResourceId ? "封面暂不可用" : "暂无图片"}
                                            </span>
                                        }
                                    />
                                </div>
                                <div className="drama-workflow-episode-title">
                                    <h3>第 {episode.number} 集</h3>
                                    <p title={episode.title}>{episode.title || "未命名分集"}</p>
                                    <span className="drama-workflow-episode-type">{summary.production.settings.dramaType ? DRAMA_TYPE_LABEL[summary.production.settings.dramaType] : summary.production.settings.styleName || "未设置剧集类型"}</span>
                                    {updatedTime(episode) ? <time dateTime={episode.updatedAt}>{new Date(updatedTime(episode)).toLocaleString("zh-CN", { hour12: false })}</time> : <span>更新时间未知</span>}
                                </div>
                            </button>
                            <footer className="drama-workflow-episode-progress">
                                <dl>
                                    <div data-status={subjectState(byId.get(episode.id))} title={subjectStatus(byId.get(episode.id))}>
                                        <dt>
                                            <span className="drama-workflow-episode-dot" aria-hidden />
                                            主体
                                        </dt>
                                        <dd className="sr-only">
                                            {PROGRESS_LABEL[subjectState(byId.get(episode.id))]} · {subjectStatus(byId.get(episode.id))}
                                        </dd>
                                    </div>
                                    <div data-status={storyboardState(episode)} title={episode.shotCount ? `${episode.shotCount} 镜头` : "等待拆镜"}>
                                        <dt>
                                            <span className="drama-workflow-episode-dot" aria-hidden />
                                            分镜
                                        </dt>
                                        <dd className="sr-only">
                                            {PROGRESS_LABEL[storyboardState(episode)]} · {episode.shotCount ? `${episode.shotCount} 镜头` : "等待拆镜"}
                                        </dd>
                                    </div>
                                    <div data-status={videoState(episode)} title={episode.stats.segments ? `${episode.stats.videoReady}/${episode.stats.segments} 段连续视频就绪` : "尚无连续视频"}>
                                        <dt>
                                            <span className="drama-workflow-episode-dot" aria-hidden />
                                            视频
                                        </dt>
                                        <dd className="sr-only">
                                            {PROGRESS_LABEL[videoState(episode)]} · {episode.stats.segments ? `${episode.stats.videoReady}/${episode.stats.segments} 段连续视频就绪` : "尚无连续视频"}
                                        </dd>
                                    </div>
                                </dl>
                                <Dropdown
                                    trigger={["click"]}
                                    placement="bottomRight"
                                    menu={{
                                        items: [
                                            { key: "open", label: `打开第 ${episode.number} 集`, onClick: () => onOpenEpisode(episode.id, episodeWorkflowEntryStep(episode)) },
                                            { key: "render", label: "合成本集成片", disabled: viewLocked, onClick: () => void prepare("render", [episode.id]) },
                                            { key: "download", label: "下载本集成片", disabled: viewLocked || !episode.finalResourceId, onClick: () => void prepare("download", [episode.id]) },
                                        ],
                                    }}
                                >
                                    <Button className="drama-workflow-episode-more" type="text" size="small" icon={<MoreVertical className="size-4" aria-hidden />} aria-label={`第 ${episode.number} 集更多操作`} disabled={viewLocked} />
                                </Dropdown>
                            </footer>
                            <span className="sr-only">{episodeStatusText(episode)}</span>
                            {episode.error ? (
                                <p className="drama-workflow-episode-error" role="status">
                                    {episode.error}
                                </p>
                            ) : null}
                            {episode.durationMs > 0 ? <small className="drama-workflow-episode-duration">{formatDuration(episode.durationMs)}</small> : null}
                        </article>
                    ))}
                </div>
            )}
            {adding ? (
                <AddEpisodeModal
                    open
                    projectId={projectId}
                    expectedRevision={summary.production.revision}
                    nextNumber={Math.max(0, ...summary.episodes.map((episode) => episode.number)) + 1}
                    defaultFormat={sourceFormatOf(summary.episodes.at(-1)?.sourceFormat)}
                    blockedReason={!summary.production.planDone ? "现有章节仍在分集规划，请完成后再追加。" : undefined}
                    onClose={() => setAdding(false)}
                    onDirtyChange={addingChanged}
                    onAdded={(id) => {
                        const ticket = creationTicket.current;
                        if (!ticket || !operation.isCurrent(ticket)) return;
                        setAdding(false);
                        setSelection(new Set([id]));
                        setSearch("");
                        setFilter("all");
                        void refresh(ticket);
                    }}
                />
            ) : null}
            {exporting ? <AssetPackageModal open projectId={projectId} episodes={summary.episodes} onClose={() => setExporting(false)} /> : null}
            {result ? (
                <AppModal
                    open
                    centered
                    width="min(760px, calc(100vw - 32px))"
                    title={result.kind === "render" ? "分集合成结果" : "成片下载结果"}
                    onCancel={() => {
                        if (!busy) setResult(undefined);
                    }}
                    closable={!busy}
                    mask={{ closable: !busy }}
                    keyboard={!busy}
                    rootClassName="drama-root"
                    footer={
                        <>
                            <Button disabled={busy} onClick={() => setResult(undefined)}>
                                关闭
                            </Button>
                            <Button
                                disabled={busy}
                                onClick={() =>
                                    void prepare(
                                        result.kind,
                                        result.items.map((item) => item.episodeId),
                                        result.items,
                                    )
                                }
                            >
                                重新检查未完成项
                            </Button>
                            {readyCount ? (
                                <Button type="primary" disabled={result.phase !== "ready" || busy} onClick={() => void execute()}>
                                    {result.kind === "render" ? `合成 ${readyCount} 集` : `下载 ${readyCount} 集成片`}
                                </Button>
                            ) : null}
                        </>
                    }
                >
                    <div className="drama-workflow-episodes-results" aria-live="polite">
                        <p>
                            范围固定为本次选择的 {result.items.length} 集。{result.kind === "render" ? "只合成已采用且完整就绪的剧情段视频。" : "每集单独发起下载，旧版成片会单独标明。"}
                        </p>
                        {result.phase === "checking" ? (
                            <p role="status">正在检查最新状态…</p>
                        ) : (
                            <p>
                                可操作 {readyCount} 集 · {result.kind === "render" ? "已提交或已有结果" : "已发起下载"} {succeededCount} 集 · 异常待检查 {failedCount} 集
                            </p>
                        )}
                        {result.error ? <p role="alert">{result.error}</p> : null}
                        {result.notice ? <p role="status">{result.notice}</p> : null}
                        <ol>
                            {result.items.map((item) => (
                                <li key={item.episodeId} data-status={item.status}>
                                    <strong>
                                        第 {item.number} 集 · {item.title || "未命名分集"}
                                    </strong>
                                    <span>{item.note}</span>
                                    {item.status === "failed" || item.status === "uncertain" ? (
                                        <Button
                                            size="small"
                                            type="text"
                                            disabled={busy}
                                            onClick={() => {
                                                setResult(undefined);
                                                onOpenEpisode(item.episodeId);
                                            }}
                                        >
                                            查看本集状态
                                        </Button>
                                    ) : null}
                                </li>
                            ))}
                        </ol>
                    </div>
                </AppModal>
            ) : null}
        </section>
    );
}
