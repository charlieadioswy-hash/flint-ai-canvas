import { useDeferredValue, useEffect, useState, type DragEvent } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Dropdown, Input } from "antd";
import { Clapperboard, ExternalLink, FileUp, MoreHorizontal, Search, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { CollectionToolbar } from "@/components/layout/collection-toolbar";
import { PageHeader, PaginationBar, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceErrorState, WorkspaceLoadingState, WorkspaceNoResultsState } from "@/components/layout/workspace-state";
import { deleteDrama, listDramas, type DramaListItem, type DramaStatus } from "@/services/api/drama";

import { formatCredits, MediaThumb, STATUS_LABEL } from "./drama-shared";
import { progressFillStyle } from "@/lib/progress-fill";
import { RelativeTime } from "@/components/ui/product/relative-time";
import { DramaWorkflowEntry } from "./workflow-entry";
import { dramaProjectPath } from "./guide-state";
import "./drama.css";

const PAGE_SIZES = [24, 48, 96];
const STATUS_FILTERS: Array<{ value: DramaStatus | "all"; label: string }> = [
    { value: "all", label: "全部" },
    { value: "running", label: "制作中" },
    { value: "paused", label: "已暂停" },
    { value: "completed", label: "已完成" },
    { value: "draft", label: "未开始" },
];

function dramaListStage(item: DramaListItem) {
    if (item.hasDraftForm) return "草稿待完善";
    if (item.guideStep === "configuring") return "配置中";
    if (item.guideStep === "assets") return "配置中 · 主体资产";
    if (item.guideStep === "story") return item.episodeCount ? `继续制作 · ${item.doneCount}/${item.episodeCount} 集成片` : "继续制作";
    if (item.guideStep === "completed") return item.episodeCount ? `文字已就绪 · ${item.doneCount}/${item.episodeCount} 集成片` : "文字已就绪";
    if (item.episodeCount) return `${item.doneCount}/${item.episodeCount} 集成片`;
    if (item.status === "running") return "正在改编小说";
    if (item.status === "draft") return "尚未开始";
    return "等待分集";
}

function dramaListAction(item: DramaListItem) {
    if (item.guideStep === "configuring" || item.guideStep === "assets") return "继续配置";
    if (item.guideStep === "story" || item.guideStep === "completed" || item.episodeCount) return "继续制作";
    return "打开制作台";
}

export default function DramaListPage() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { message, modal } = App.useApp();
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
    const [keyword, setKeyword] = useState("");
    const [status, setStatus] = useState<DramaStatus | "all">("all");
    const [dragging, setDragging] = useState(false);
    const search = useDeferredValue(keyword.trim());
    useEffect(() => setPage(1), [search, status, pageSize]);

    const query = useQuery({
        queryKey: ["dramas", { page, pageSize, search, status }],
        queryFn: ({ signal }) => listDramas({ page, pageSize, q: search || undefined, status: status === "all" ? undefined : status }, signal),
        placeholderData: keepPreviousData,
        refetchInterval: (state) => (state.state.data?.items.some((item) => item.status === "running") ? 8_000 : false),
    });
    const remove = useMutation({
        mutationFn: deleteDrama,
        onSuccess: () => {
            message.success("作品已删除");
            void queryClient.invalidateQueries({ queryKey: ["dramas"] });
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });
    const data = query.data;
    const counts = data?.statusCounts || {};
    const total = counts.all ?? 0;
    const filtered = Boolean(search || status !== "all");
    const openFile = (file: File) => navigate("/projects/new", { state: { file } });
    const confirmDelete = (item: DramaListItem) => {
        modal.confirm({
            title: `删除《${item.project.name}》？`,
            content: "小说原文、剧本、分镜与成片记录都会删除。此操作无法撤销。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            centered: true,
            onOk: () => remove.mutateAsync(item.project.id),
        });
    };
    // 整页都能拖入小说：列表页不再单独放一块上传区占位置。
    const dragProps = {
        onDragOver: (event: DragEvent) => {
            if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                setDragging(true);
            }
        },
        onDragLeave: (event: DragEvent) => {
            if (event.currentTarget === event.target) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) openFile(file);
        },
    };

    if (query.isLoading)
        return (
            <WorkspacePage className="studio-collection-page">
                <WorkspaceLoadingState label="正在读取作品" />
            </WorkspacePage>
        );
    if (query.isError && !data)
        return (
            <WorkspacePage className="studio-collection-page">
                <WorkspaceErrorState description="作品列表暂时无法读取。" onRetry={() => void query.refetch()} />
            </WorkspacePage>
        );

    return (
        <WorkspacePage className="studio-collection-page drama-library">
            <div className="drama-root" {...dragProps}>
                <div className="studio-band">
                    <DramaWorkflowEntry />
                    <PageHeader title="最近作品" meta={<span className="app-projects-header-meta">{total} 部</span>} />
                    {total ? (
                        <CollectionToolbar
                            label="短剧浏览工具"
                            active={filtered}
                            onReset={() => {
                                setKeyword("");
                                setStatus("all");
                            }}
                        >
                            <Input prefix={<Search />} value={keyword} allowClear placeholder="搜索作品名" aria-label="搜索作品名" onChange={(event) => setKeyword(event.target.value)} />
                            <div className="drama-library-status" role="radiogroup" aria-label="按状态筛选">
                                {STATUS_FILTERS.map((item) => {
                                    const count = item.value === "all" ? total : counts[item.value] || 0;
                                    if (item.value !== "all" && !count && status !== item.value) return null;
                                    return (
                                        <button key={item.value} type="button" role="radio" aria-checked={status === item.value} className={`drama-library-status-item is-${item.value}`} onClick={() => setStatus(item.value)}>
                                            {item.value !== "all" ? <span className="drama-dot" /> : null}
                                            {item.label}
                                            <b>{count}</b>
                                        </button>
                                    );
                                })}
                            </div>
                        </CollectionToolbar>
                    ) : null}
                </div>

                {total ? (
                    data?.items.length ? (
                        <>
                            <div className={`drama-library-grid ${query.isPlaceholderData ? "is-stale" : ""}`}>
                                {data.items.map((item) => (
                                    <DramaCard key={item.project.id} item={item} onDelete={() => confirmDelete(item)} />
                                ))}
                            </div>
                            <PaginationBar
                                current={page}
                                pageSize={pageSize}
                                total={data.total}
                                itemLabel="部"
                                pageSizeOptions={PAGE_SIZES}
                                onChange={(next, size) => {
                                    setPage(next);
                                    setPageSize(size);
                                }}
                            />
                        </>
                    ) : (
                        <WorkspaceNoResultsState
                            icon="projects"
                            query={keyword}
                            description="换一个作品名，或清除状态筛选。"
                            onClear={() => {
                                setKeyword("");
                                setStatus("all");
                            }}
                        />
                    )
                ) : (
                    <p className="drama-library-empty">还没有作品，从上方选择一种方式开始创作。</p>
                )}

                {dragging ? (
                    <div className="drama-library-drop" aria-hidden>
                        <div>
                            <FileUp className="size-8" />
                            <strong>松开即可开始新短剧</strong>
                            <span>TXT / Markdown / DOCX，自动识别编码与章节</span>
                        </div>
                    </div>
                ) : null}
            </div>
        </WorkspacePage>
    );
}

function DramaCover({ item }: { item: DramaListItem }) {
    const covers = (item.coverResourceIds?.length ? item.coverResourceIds : item.coverResourceId ? [item.coverResourceId] : []).slice(0, 4);
    if (!covers.length) {
        return (
            <div className="drama-library-cover is-empty">
                <span className="drama-library-glyph">{item.project.name.slice(0, 1)}</span>
                <Clapperboard className="drama-library-empty-icon" />
            </div>
        );
    }
    return (
        <div className={`drama-library-cover is-${covers.length}`}>
            {covers.map((id) => (
                <span key={id}>
                    <MediaThumb resourceId={id} alt="" />
                </span>
            ))}
        </div>
    );
}

function DramaCard({ item, onDelete }: { item: DramaListItem; onDelete: () => void }) {
    const progress = item.episodeCount ? Math.round((item.doneCount / item.episodeCount) * 100) : 0;
    const needsAction = item.status === "paused" && Boolean(item.pauseReason);
    const path = item.hasDraftForm ? `/projects/new?draft=${encodeURIComponent(item.project.id)}` : dramaProjectPath(item.project.id, item.guideStep, item.episodeCount);
    const stage = dramaListStage(item);
    return (
        <article className={`drama-library-card is-${item.status}`}>
            <Link to={path} className="drama-library-open" aria-label={`打开《${item.project.name}》`}>
                <DramaCover item={item} />
                <div className="drama-library-body">
                    <h3 title={item.project.name}>{item.project.name}</h3>
                    <span className={`drama-chip drama-library-badge is-${needsAction ? "paused" : item.status}`}>
                        <span className="drama-dot" />
                        {needsAction ? "需要处理" : item.status === "completed" && (!item.episodeCount || item.doneCount < item.episodeCount) ? "待制作视频" : STATUS_LABEL[item.status]}
                    </span>
                    <div className="drama-library-meta">
                        {item.styleName ? <span>{item.styleName}</span> : null}
                        <span>{item.aspectRatio}</span>
                        <RelativeTime value={item.updatedAt || item.project.updatedAt} />
                    </div>
                    <div className="drama-library-progress">
                        <span className="drama-library-progress-bar">
                            <span style={progressFillStyle(Math.max(progress, item.episodeCount && progress === 0 ? 2 : progress))} />
                        </span>
                        <span className="drama-library-progress-text">
                            <b>{stage}</b>
                            {item.spentMicrocredits ? <span>{formatCredits(item.spentMicrocredits)} 积分</span> : null}
                        </span>
                    </div>
                    {needsAction ? (
                        <p className="drama-library-alert" title={item.pauseReason}>
                            {item.pauseReason}
                        </p>
                    ) : null}
                </div>
            </Link>
            <div className="drama-library-menu">
                <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    menu={{
                        items: [
                            { key: "open", icon: <ExternalLink className="size-3.5" />, label: <Link to={path}>{item.hasDraftForm ? "编辑草稿" : dramaListAction(item)}</Link> },
                            { type: "divider" },
                            { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: "删除作品", onClick: onDelete },
                        ],
                    }}
                >
                    <button type="button" className="product-icon-button" aria-label={`${item.project.name} 更多操作`}>
                        <MoreHorizontal />
                    </button>
                </Dropdown>
            </div>
        </article>
    );
}
